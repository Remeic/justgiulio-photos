/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const EXIF_SCHEMA_VERSION = 3;

// ---------- helper ----------------------------------------------------------

const md5 = (f) =>
  crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");

const PHOTO_TAG_WHITELIST = [
  "Make",
  "Model",
  "LensMake",
  "LensModel",
  "LensID",
  "LensInfo",
  "CameraType",
  "FNumber",
  "Aperture",
  "ApertureValue",
  "ExposureTime",
  "ShutterSpeed",
  "ShutterSpeedValue",
  "ISO",
  "ExposureProgram",
  "ExposureMode",
  "ExposureCompensation",
  "MeteringMode",
  "WhiteBalance",
  "Flash",
  "FocalLength",
  "FocalLengthIn35mmFormat",
  "FocusDistance",
  "FocusDistanceRange",
  "FocusPosition",
  "SubjectDistance",
  "LightValue",
  "Megapixels",
  "ImageSize",
  "ColorTemperature",
  "HDRHeadroom",
  "DateTimeOriginal",
  "CreateDate",
  "SubSecTimeOriginal",
  "SubSecCreateDate",
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
  "GPSPosition",
  "GPSImgDirection",
  "GPSHPositioningError",
];

const toNumeric = (value) => {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const fraction = value.match(
      /^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/
    );
    if (fraction) {
      const numerator = Number(fraction[1]);
      const denominator = Number(fraction[2]);
      if (!denominator) return null;
      return numerator / denominator;
    }
    const number = value.match(/-?\d+(?:\.\d+)?/);
    if (number) return Number(number[0]);
  }
  return null;
};

const filterExifTags = (rawData, typedData) => {
  const merged = { ...(rawData || {}), ...(typedData || {}) };
  const filtered = {};
  for (const key of PHOTO_TAG_WHITELIST) {
    if (!(key in merged)) continue;
    let value = merged[key];
    if (value == null) continue;
    if (value instanceof Date) value = value.toISOString();
    else if (
      value &&
      typeof value === "object" &&
      typeof value.toISOString === "function"
    ) {
      value = value.toISOString();
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.toString === "function"
    ) {
      const str = value.toString();
      if (str && str !== "[object Object]") value = str;
    }
    if (typeof value === "string" && !value.trim()) continue;
    filtered[key] = value;
  }
  return filtered;
};

const dims = async (f) => {
  try {
    const m = await sharp(f).metadata();
    return {
      width: m.width || 0,
      height: m.height || 0,
      format: m.format || "unknown",
    };
  } catch (e) {
    console.warn(`dim fail ${f}: ${e.message}`);
    return { width: 0, height: 0, format: "unknown" };
  }
};

const toIsoString = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.toISOString === "function") return value.toISOString();
    if (typeof value.toString === "function") return value.toString();
  }
  return null;
};

const exif = async (f) => {
  try {
    const ext = path.extname(f).toLowerCase();
    if (ext === ".gif") return {};

    const [typed, raw] = await Promise.all([
      exiftool.read(f),
      exiftool.readRaw(f),
    ]);

    const apertureValue = toNumeric(typed.FNumber);
    const isoValue = toNumeric(typed.ISO);
    const exposureValue = toNumeric(typed.ExposureTime);
    const focalValue = toNumeric(typed.FocalLength);
    const latitude = toNumeric(typed.GPSLatitude);
    const longitude = toNumeric(typed.GPSLongitude);
    const altitudeValue = toNumeric(typed.GPSAltitude);
    const directionValue = toNumeric(typed.GPSImgDirection);
    const gpsError = toNumeric(typed.GPSHPositioningError);

    let shutterSpeed = null;
    if (Number.isFinite(exposureValue) && exposureValue > 0) {
      if (exposureValue >= 1) {
        shutterSpeed = `${exposureValue.toFixed(1)}s`;
      } else {
        const denom = Math.round(1 / exposureValue);
        if (denom) shutterSpeed = `1/${denom}s`;
      }
    }

    let gps = null;
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      gps = { latitude, longitude };
      if (Number.isFinite(altitudeValue)) gps.altitude = altitudeValue;
      if (Number.isFinite(directionValue)) gps.direction = directionValue;
      if (Number.isFinite(gpsError)) gps.horizontalAccuracy = gpsError;
    }

    return {
      camera:
        typed.Make || typed.Model
          ? `${typed.Make ?? ""} ${typed.Model ?? ""}`.trim() || null
          : null,
      aperture: Number.isFinite(apertureValue)
        ? `f/${apertureValue.toFixed(1)}`
        : null,
      iso: Number.isFinite(isoValue) ? Math.round(isoValue) : null,
      shutterSpeed,
      focalLength: Number.isFinite(focalValue)
        ? `${focalValue.toFixed(1)}mm`
        : null,
      gps,
      dateTaken:
        toIsoString(typed.DateTimeOriginal) ??
        toIsoString(typed.CreateDate) ??
        null,
      raw: filterExifTags(raw, typed),
      schemaVersion: EXIF_SCHEMA_VERSION,
    };
  } catch (e) {
    console.warn(`exif fail ${f}: ${e.message}`);
    return {};
  }
};

const makeThumb = async (src, dst, w = 600) => {
  try {
    const m = await sharp(src).metadata();
    const h = Math.round(w / ((m.width || 1) / (m.height || 1)));
    let pipe = sharp(src).rotate().resize(w, h, {
      fit: "inside",
      withoutEnlargement: true,
    });

    // Riduci la grandezza delle immagini del 35%
    const resizeFactor = 0.65;
    const newW = Math.round(w * resizeFactor);
    const newH = Math.round(h * resizeFactor);

    pipe = sharp(src).rotate().resize(newW, newH, {
      fit: "inside",
      withoutEnlargement: true,
    });

    // PNG/GIF con alpha restano PNG; altrimenti JPEG
    if (m.hasAlpha || m.format === "png" || m.format === "gif") {
      pipe = pipe.png({ compressionLevel: 9, effort: 10 });
    } else {
      pipe = pipe.jpeg({ quality: 40, progressive: true, mozjpeg: true });
    }
    await pipe.toFile(dst);
    // Return actual written dimensions
    return { width: newW, height: newH, size: fs.statSync(dst).size };
  } catch (e) {
    console.warn(`thumb fail ${src}: ${e.message}`);
    return null;
  }
};

// ---------- main ------------------------------------------------------------

(async () => {
  console.log("🔄 Generating metadata & thumbnails");

  const root = path.join(__dirname, "..");
  const photosDir = path.join(root, "photos");
  const outFile = path.join(root, "metadata.json");
  const thumbsDir = path.join(root, "thumbnails");
  const RAW_BASE = `https://raw.githubusercontent.com/${
    process.env.GITHUB_REPOSITORY || "Remeic/justgiulio-photos"
  }/main`;

  try {
    fs.mkdirSync(photosDir, { recursive: true });
    fs.mkdirSync(thumbsDir, { recursive: true });

    // --- scan photos dir ------------------------------------------------------
    const walk = (dir, base = "") =>
      fs.readdirSync(dir).flatMap((f) => {
        const full = path.join(dir, f);
        const rel = path.join(base, f).replace(/\\/g, "/");
        const st = fs.statSync(full);
        if (st.isDirectory()) return walk(full, rel);
        if (st.isFile() && IMAGE_EXT.includes(path.extname(f).toLowerCase()))
          return [
            {
              path: rel,
              name: f,
              size: st.size,
              modified: st.mtime.toISOString(),
              hash: md5(full),
            },
          ];
        return [];
      });

    const photos = walk(photosDir);
    if (!photos.length) {
      fs.writeFileSync(
        outFile,
        JSON.stringify(
          {
            generated: new Date().toISOString(),
            totalPhotos: 0,
            categories: [],
            photos: [],
            totalSize: 0,
          },
          null,
          2
        )
      );
      console.log("⚠️  no photos");
      return;
    }

    // --- load cache -----------------------------------------------------------
    const prev = fs.existsSync(outFile)
      ? JSON.parse(fs.readFileSync(outFile, "utf8")).photos || []
      : [];
    const cache = new Map(prev.map((p) => [p.path, p]));

    // --- process photos -------------------------------------------------------
    const processed = [];
    for (const p of photos) {
      const cached = cache.get(p.path);
      const cachedHasRaw = cached?.exif && "raw" in cached.exif;
      const exifVersionChanged =
        cached?.exif?.schemaVersion !== EXIF_SCHEMA_VERSION;
      const changed =
        cached?.hash !== p.hash || !cachedHasRaw || exifVersionChanged;
      const full = path.join(photosDir, p.path);
      const cat = p.path.split("/")[0] || "uncategorized";

      // thumbnail filename
      const ext = path.extname(p.path).toLowerCase();
      const thumbRel =
        ext === ".png" || ext === ".gif"
          ? p.path.replace(ext, "_thumb.png")
          : p.path.replace(ext, "_thumb.jpg");
      const thumbAbs = path.join(thumbsDir, thumbRel);
      fs.mkdirSync(path.dirname(thumbAbs), { recursive: true });

      const needThumb = changed || !fs.existsSync(thumbAbs);

      const d = changed
        ? await dims(full)
        : cached?.dimensions ?? (await dims(full));
      const e = changed ? await exif(full) : cached?.exif ?? (await exif(full));
      const t = needThumb ? await makeThumb(full, thumbAbs) : cached?.thumbnail;

      processed.push({
        id: p.path.replace(/[^a-z0-9]/gi, "_"),
        path: p.path,
        name: p.name,
        category: cat,
        size: p.size,
        modified: p.modified,
        hash: p.hash,
        dimensions: d,
        exif: e,
        thumbnail: t,
        url: `${RAW_BASE}/photos/${p.path}`,
        thumbnailUrl: `${RAW_BASE}/thumbnails/${thumbRel}`,
      });
    }

    processed.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    const cats = Object.values(
      processed.reduce((m, p) => {
        m[p.category] ??= { name: p.category, photoCount: 0, totalSize: 0 };
        m[p.category].photoCount++;
        m[p.category].totalSize += p.size;
        return m;
      }, {})
    ).sort((a, b) => b.photoCount - a.photoCount);

    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          totalPhotos: processed.length,
          totalSize: processed.reduce((s, p) => s + p.size, 0),
          categories: cats,
          photos: processed,
        },
        null,
        2
      )
    );

    console.log(`✅ done (${processed.length} photos, ${cats.length} cats)`);
  } finally {
    await exiftool.end();
  }
})();
