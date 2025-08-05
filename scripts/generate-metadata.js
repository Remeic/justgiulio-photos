/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import exifr from "exifr/dist/full.esm.mjs";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

// ---------- helper ----------------------------------------------------------

const md5 = (f) =>
  crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");

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

const exif = async (f) => {
  try {
    const t = await exifr(f, [
      "Make",
      "Model",
      "FNumber",
      "ISO",
      "ExposureTime",
      "FocalLength",
      "GPSLatitude",
      "GPSLongitude",
      "DateTimeOriginal",
      "CreateDate",
    ]);

    return {
      camera:
        t.Make || t.Model
          ? `${t.Make ?? ""} ${t.Model ?? ""}`.trim() || null
          : null,
      aperture: t.FNumber ? `f/${Number(t.FNumber).toFixed(1)}` : null,
      iso: t.ISO != null ? Math.round(t.ISO) : null,
      shutterSpeed: t.ExposureTime
        ? `${Number(t.ExposureTime).toFixed(3)}s`
        : null,
      focalLength: t.FocalLength
        ? `${Number(t.FocalLength).toFixed(1)}mm`
        : null,
      gps:
        t.GPSLatitude != null && t.GPSLongitude != null
          ? { latitude: t.GPSLatitude, longitude: t.GPSLongitude }
          : null,
      dateTaken: t.DateTimeOriginal ?? t.CreateDate ?? null,
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
    let pipe = sharp(src).resize(w, h, {
      fit: "inside",
      withoutEnlargement: true,
    });

    // PNG/GIF con alpha restano PNG; altrimenti JPEG
    if (m.hasAlpha || m.format === "png" || m.format === "gif") {
      pipe = pipe.png({ compressionLevel: 9, effort: 10 });
    } else {
      pipe = pipe.jpeg({ quality: 40 });
    }
    await pipe.toFile(dst);
    return { width: w, height: h, size: fs.statSync(dst).size };
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
    const changed = cached?.hash !== p.hash;
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
    const t = needThumb ? await makeThumb(full, thumbAbs) : cached.thumbnail;

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
})();
