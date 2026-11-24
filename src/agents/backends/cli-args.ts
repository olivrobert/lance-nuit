/** Appends `flag value`, or nothing when the value is absent or empty. */
export function pushOption(args: string[], flag: string, value: string | undefined): void {
  if (value != null && value !== "") args.push(flag, value);
}
