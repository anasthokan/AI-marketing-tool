import path from "path";
import { fileURLToPath } from "url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const getBackendRoot = () => backendRoot;

export const getUploadsRoot = () => path.join(backendRoot, "uploads");
