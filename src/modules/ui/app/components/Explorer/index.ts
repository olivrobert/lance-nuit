// Public surface of the explorer: the Files-tab tree-and-reader (`Folder`)
// and the Document-tab single-file reader (`DocumentView`), plus the reader
// panel itself (`FileView`) for anything that wants to embed it directly.
// Both `Folder` and `DocumentView` take no props — they read the store.

export { DocumentView } from "./DocumentView.js";
export { FileView } from "./FileView.js";
export { Folder } from "./Folder.js";
