#!/usr/bin/env bun

import { $ } from "bun";
import { readdir, stat } from "fs/promises";
import { join, extname } from "path";

interface ImageInfo {
  path: string;
  name: string;
  basename: string;
  size: number;
  width?: number;
  height?: number;
  dateTime?: string;
}

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".tiff", ".tif", ".heic"];

async function getImageFiles(dir: string): Promise<string[]> {
  const files = await readdir(dir);
  return files
    .filter((f) => IMAGE_EXTENSIONS.includes(extname(f).toLowerCase()))
    .map((f) => join(dir, f));
}

async function getImageInfo(filePath: string): Promise<ImageInfo> {
  const stats = await stat(filePath);
  const fileName = filePath.split("/").pop()!;
  const info: ImageInfo = {
    path: filePath,
    name: fileName,
    basename: fileName.substring(0, fileName.lastIndexOf(".")) || fileName,
    size: stats.size,
  };

  try {
    const result =
      await $`exiftool -ImageWidth -ImageHeight -DateTimeOriginal -CreateDate -j ${filePath}`.quiet();
    const data = JSON.parse(result.text())[0];

    info.width = data.ImageWidth;
    info.height = data.ImageHeight;
    info.dateTime = data.DateTimeOriginal || data.CreateDate;
  } catch (e) {
    console.warn(`Impossibile leggere metadati di ${info.name}`);
  }

  return info;
}

function findBestMatch(
  edited: ImageInfo,
  originals: ImageInfo[]
): ImageInfo | null {
  const sameName = originals.find((o) => o.basename === edited.basename);
  if (sameName) {
    return sameName;
  }

  if (edited.width && edited.height) {
    const sameResolution = originals.filter(
      (o) => o.width === edited.width && o.height === edited.height
    );

    if (sameResolution.length === 1) {
      return sameResolution[0];
    }

    if (sameResolution.length > 1 && edited.dateTime) {
      const byDate = sameResolution.find((o) => o.dateTime === edited.dateTime);
      if (byDate) return byDate;
    }
  }

  if (edited.dateTime) {
    const sameDate = originals.find((o) => o.dateTime === edited.dateTime);
    if (sameDate) return sameDate;
  }

  const similarSize = originals.filter((o) => {
    const ratio = o.size / edited.size;
    return ratio > 0.8 && ratio < 5;
  });

  if (similarSize.length === 1) {
    return similarSize[0];
  }

  return null;
}

async function copyExif(source: string, target: string): Promise<boolean> {
  try {
    // 1) pulizia target (previene conflitti strutturali)
    await $`exiftool -overwrite_original -all= ${target}`.quiet();

    // 2) primo tentativo: copia “pulita”
    let res =
      await $`exiftool -overwrite_original -TagsFromFile ${source} -EXIF:all -XMP:all -IPTC:all -ICC_Profile:all ${target}`.quiet();

    if (res.exitCode === 0) return true;

    // 3) fallback: forza fix puntatori e ignora warning minori
    res =
      await $`exiftool -m -F -overwrite_original -TagsFromFile ${source} -EXIF:all -XMP:all -IPTC:all -ICC_Profile:all ${target}`.quiet();

    if (res.exitCode === 0) return true;

    // 4) ultimo tentativo: copia “safe” di soli tag chiave (data, gps, camera)
    res =
      await $`exiftool -m -F -overwrite_original -TagsFromFile ${source} -EXIF:DateTimeOriginal -EXIF:CreateDate -EXIF:ModifyDate -EXIF:Make -EXIF:Model -EXIF:LensModel -EXIF:FocalLength -EXIF:FNumber -EXIF:ExposureTime -EXIF:ISO -EXIF:Orientation -EXIF:GPS* -XMP:CreateDate -XMP:DateCreated -XMP:Rights ${target}`.quiet();

    return res.exitCode === 0;
  } catch (e: any) {
    console.error(
      "\nERRORE EXIFTOOL (fatal): " + (e.stderr?.toString() || e.message)
    );
    return false;
  }
}

const [originalsDir, editedDir] = process.argv.slice(2);

if (!originalsDir || !editedDir) {
  console.error(
    "Uso: bun run copy-exif.ts <cartella-originali> <cartella-editate>"
  );
  console.error("");
  console.error("Esempio:");
  console.error("  bun run copy-exif.ts ~/Photos/Originali ~/Photos/Editate");
  process.exit(1);
}

console.log("Scansione cartelle...\n");

const originalFiles = await getImageFiles(originalsDir);
const editedFiles = await getImageFiles(editedDir);

console.log("Trovati " + originalFiles.length + " file originali");
console.log("Trovati " + editedFiles.length + " file editati\n");

console.log("Analisi metadati in corso...\n");

const originals = await Promise.all(originalFiles.map(getImageInfo));
const edited = await Promise.all(editedFiles.map(getImageInfo));

let matched = 0;
let copied = 0;
const unmatched: string[] = [];

for (const edit of edited) {
  const match = findBestMatch(edit, originals);

  if (match) {
    matched++;
    console.log("\nMATCH trovato:");
    console.log("  Originale: " + match.path);
    console.log("  Editata:   " + edit.path);
    process.stdout.write("  Copia EXIF... ");

    const success = await copyExif(match.path, edit.path);
    if (success) {
      copied++;
      console.log("OK");
    } else {
      console.log("ERRORE (vedi sopra)");
    }
  } else {
    unmatched.push(edit.name);
  }
}

console.log("\n==================================================");
console.log("Risultati:");
console.log("  Corrispondenze trovate: " + matched + "/" + edited.length);
console.log("  EXIF copiati con successo: " + copied);
console.log("  File senza corrispondenza: " + unmatched.length);

if (unmatched.length > 0) {
  console.log("\nFile editati senza corrispondenza:");
  unmatched.forEach((f) => console.log("  - " + f));
  console.log("\nPer questi file usa:");
  console.log("  exiftool -TagsFromFile originale.jpg -all:all editata.jpg");
}
