
import path from "path";
import fs from "fs";
import multer from "multer";
export function getUploadsBaseDir() {
  return path.resolve(process.cwd(), "uploads");
}
export function makeDiskStorage(prefix = "file") {
  const baseDir = getUploadsBaseDir();
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      cb(null, baseDir);
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `${prefix}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
  });
}
export function selectStorage(prefix = "file") {
  return process.env.VERCEL ? multer.memoryStorage() : makeDiskStorage(prefix);
}

export default {
  getUploadsBaseDir,
  makeDiskStorage,
  selectStorage
};

