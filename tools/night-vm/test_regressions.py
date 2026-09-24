"""Offline checks: no real Incus commands or forge credentials are used."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("broker", HERE / "broker/gh-broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class BrokerTests(unittest.TestCase):
    def test_credential_checked_before_body_or_gh_execution(self):
        for token in (None, "b" * 64, "a" * 64):
            with self.subTest(token=token):
                handler = object.__new__(broker.Handler)
                handler.token = "a" * 64
                handler.repo = "owner/repo"
                handler.path = "/gh"
                body = json.dumps({"args": ["issue", "list", "--json", "number"]}).encode()
                handler.headers = {"Content-Length": str(len(body))}
                if token:
                    handler.headers["Authorization"] = f"Bearer {token}"
                handler.rfile = io.BytesIO(body)
                handler._reply = Mock()
                completed = subprocess.CompletedProcess([], 0, "[]", "")
                with patch.object(broker.subprocess, "run", return_value=completed) as gh:
                    with contextlib.redirect_stdout(io.StringIO()) as logs:
                        handler.do_POST()
                if token == handler.token:
                    self.assertEqual(handler._reply.call_args.args[0], 200)
                    self.assertEqual(gh.call_args.args[0][-2:], ["--repo", "owner/repo"])
                else:
                    self.assertEqual(handler._reply.call_args.args[0], 403)
                    gh.assert_not_called()
                    self.assertEqual(handler.rfile.tell(), 0)
                self.assertNotIn("a" * 64, logs.getvalue())
                self.assertNotIn("b" * 64, logs.getvalue())

    def test_shim_transmits_run_credential_and_preserves_output(self):
        class EchoHandler(broker.Handler):
            token = "a" * 64
            repo = "owner/repo"

        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("a" * 64)
            server = broker.ThreadingHTTPServer(("127.0.0.1", 0), EchoHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            environment = dict(os.environ, GH_BROKER_URL=f"http://127.0.0.1:{server.server_port}/gh",
                               GH_BROKER_TOKEN_FILE=str(token_file))
            real_run = subprocess.run
            try:
                with patch.object(broker.subprocess, "run", return_value=subprocess.CompletedProcess([], 7, "result", "detail")):
                    result = real_run(["node", str(HERE / "broker/gh-shim"), "issue", "list"],
                                      env=environment, capture_output=True, text=True, timeout=10)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (7, "result", "detail"))
                token_file.write_text("b" * 64)
                result = real_run(["node", str(HERE / "broker/gh-shim"), "issue", "list"],
                                  env=environment, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 1)
                self.assertIn("invalid run credential", result.stderr)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.log = self.root / "calls"
        self.env = dict(os.environ, PATH=f"{self.root}:{os.environ['PATH']}", CALL_LOG=str(self.log))
        self.executable("gh", '#!/bin/sh\nexit "${AUTH_EXIT:-0}"\n')
        self.executable("incus", '''#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
copy) exit "${COPY_EXIT:-0}" ;;
start) exit "${START_EXIT:-0}" ;;
esac
cat >/dev/null
''')

    def executable(self, name, content):
        path = self.root / name
        path.write_text(content)
        path.chmod(0o755)

    def run_script(self, name, *args, **environment):
        return subprocess.run(["bash", str(HERE / name), *args], cwd=self.root,
                              env=dict(self.env, **environment), input="", text=True,
                              capture_output=True, timeout=10)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_auth_failure_does_not_delete_a_vm(self):
        result = self.run_script("test-broker-vm.sh", AUTH_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_copy_failure_does_not_delete_a_vm(self):
        self.run_script("test-broker-vm.sh", COPY_EXIT="1")
        self.assertEqual(len(self.calls()), 1)
        self.assertTrue(self.calls()[0].startswith("copy nuit-template/clean nuit-brokertest-"))

    def test_cleanup_only_deletes_its_unique_clone(self):
        names = []
        for _ in range(2):
            result = self.run_script("test-broker-vm.sh", START_EXIT="1")
            self.assertNotEqual(result.returncode, 0)
            copy, start, delete = self.calls()[-3:]
            name = copy.split()[-1]
            names.append(name)
            self.assertEqual(start, f"start {name}")
            self.assertEqual(delete, f"delete {name} --force")
        self.assertNotEqual(*names)

    def test_keep_preserves_created_clone(self):
        self.run_script("test-broker-vm.sh", "--keep", START_EXIT="1")
        self.assertEqual(len(self.calls()), 2)
        self.assertFalse(any(call.startswith("delete") for call in self.calls()))

    def test_provision_validates_digest_before_incus(self):
        tarball = self.root / "package.tgz"
        tarball.write_bytes(b"fixture")
        result = self.run_script("provision-template.sh", "--tarball", str(tarball),
                                 "--commit", "1234567", "--sha256", "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_provision_uses_supplied_tarball_and_versioned_hook(self):
        tarball = self.root / "package with spaces.tgz"
        tarball.write_bytes(b"fixture")
        result = self.run_script("provision-template.sh", "--tarball", str(tarball),
                                 "--commit", "1234567", "--sha256", hashlib.sha256(b"fixture").hexdigest())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"file push {tarball} nuit-template/root/lance-nuit-0.1.0.tgz", self.calls())
        self.assertIn(f"file push {HERE / 'pre-push'} nuit-template/etc/git-hooks/pre-push --mode 0755", self.calls())


class SshProbeTests(unittest.TestCase):
    def probe(self, connection_error=None, dns_error=None):
        # Execute the exact Python probe passed to incus, with a simulated socket.
        source = (HERE / "test-broker-vm.sh").read_text()
        probe = source.split('incus exec "$VM" -- python3 -c \'', 1)[1].split("' 2>&1", 1)[0]
        connection = Mock()
        connection.connect.side_effect = connection_error
        with patch.object(socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("192.0.2.1", 22))], side_effect=dns_error):
            with patch.object(socket, "socket") as factory:
                factory.return_value.__enter__.return_value = connection
                with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as result:
                    exec(probe, {})
        return result.exception.code

    def test_open_port_fails_confinement_without_authentication(self):
        self.assertEqual(self.probe(), 0)

    def test_rejected_and_timed_out_connections_are_blocked(self):
        self.assertEqual(self.probe(ConnectionRefusedError(111, "refused")), 1)
        self.assertEqual(self.probe(TimeoutError()), 1)

    def test_dns_failure_is_not_a_pass(self):
        self.assertEqual(self.probe(dns_error=socket.gaierror("DNS failed")), 2)


if __name__ == "__main__":
    unittest.main()
