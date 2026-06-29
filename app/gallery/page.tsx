import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Image from "next/image";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { connection } from "next/server";

const ARCHIVE_FILE_PATH = path.join(
  process.cwd(),
  ".next",
  "cache",
  "twitter-image-gallery.json",
);

type GalleryImage = {
  id: string;
  imageUrl: string;
  mediaUrl?: string;
  mediaType?: "photo" | "video" | "animated_gif";
  alt: string;
  sourceUrl: string;
  postText: string;
  authorName: string;
  username?: string;
  width: number;
  height: number;
  collectionName?: string;
  trendName?: string;
};

type SavedImageArchive = {
  images: GalleryImage[];
  savedAt: string;
};

function isSavedImageArchive(value: unknown): value is SavedImageArchive {
  if (!value || typeof value !== "object") {
    return false;
  }

  const archive = value as Partial<SavedImageArchive>;

  return (
    typeof archive.savedAt === "string" &&
    Array.isArray(archive.images) &&
    archive.images.every(
      (image) =>
        image &&
        typeof image.id === "string" &&
        typeof image.imageUrl === "string" &&
        typeof image.alt === "string" &&
        typeof image.sourceUrl === "string" &&
        typeof image.postText === "string" &&
        typeof image.authorName === "string" &&
        typeof image.width === "number" &&
        typeof image.height === "number" &&
        (typeof image.collectionName === "string" ||
          typeof image.trendName === "string"),
    )
  );
}

function getProxiedVideoUrl(mediaUrl: string) {
  return `/api/x-video?url=${encodeURIComponent(mediaUrl)}`;
}

function GalleryMedia({ item }: { item: GalleryImage }) {
  if (
    item.mediaUrl &&
    (item.mediaType === "video" || item.mediaType === "animated_gif")
  ) {
    return (
      <a
        href={item.sourceUrl}
        target="_blank"
        rel="noreferrer"
        aria-label="Open source post"
      >
        <video
          src={getProxiedVideoUrl(item.mediaUrl)}
          poster={item.imageUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          className="h-auto w-full"
        />
      </a>
    );
  }

  return (
    <a
      href={item.sourceUrl}
      target="_blank"
      rel="noreferrer"
      aria-label="Open source post"
    >
      <Image
        src={item.imageUrl}
        alt={item.alt}
        width={item.width}
        height={item.height}
        className="h-auto w-full transition duration-300 group-hover:scale-[1.02]"
        sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
      />
    </a>
  );
}

async function readSavedImages() {
  try {
    const archiveText = await readFile(ARCHIVE_FILE_PATH, "utf8");
    const archive = JSON.parse(archiveText) as unknown;

    if (!isSavedImageArchive(archive)) {
      return [];
    }

    return archive.images;
  } catch {
    return [];
  }
}

function getImageKey(image: Pick<GalleryImage, "id" | "imageUrl">) {
  return `${image.id}:${image.imageUrl}`;
}

async function writeSavedImages(images: GalleryImage[]) {
  await mkdir(path.dirname(ARCHIVE_FILE_PATH), { recursive: true });
  await writeFile(
    ARCHIVE_FILE_PATH,
    JSON.stringify({ images, savedAt: new Date().toISOString() }, null, 2),
  );
}

async function deleteSavedImage(formData: FormData) {
  "use server";

  const imageKey = formData.get("imageKey");

  if (typeof imageKey !== "string" || !imageKey) {
    return;
  }

  const images = await readSavedImages();
  const nextImages = images.filter((image) => getImageKey(image) !== imageKey);

  if (nextImages.length === images.length) {
    return;
  }

  await writeSavedImages(nextImages);
  revalidatePath("/gallery");
}

export default async function GalleryPage() {
  await connection();

  const images = await readSavedImages();

  return (
    <main className="min-h-screen bg-[#fbf8fb] text-[#211923]">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-[#ead9e5] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-sm font-semibold uppercase text-[#0b8e4a]">
              Saved gallery
            </p>
            <h1 className="text-4xl font-semibold leading-11 text-[#211923]">
              Saved images
            </h1>
          </div>
          <Link
            href="/"
            className="w-fit rounded-md border border-[#ead9e5] bg-white px-4 py-2 text-sm font-semibold text-[#6f5d69] transition hover:border-[#0fa958] hover:text-[#0b8e4a]"
          >
            Back
          </Link>
        </header>

        {images.length === 0 ? (
          <p className="text-sm font-medium text-[#6f5d69]">
            No saved images yet. Press generate images on the front page to add
            the next batch here.
          </p>
        ) : (
          <section
            aria-label="Saved images"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            {images.map((item, index) => (
              <article
                key={`${item.id}-${index}`}
                className="group relative overflow-hidden rounded-lg border border-[#ead9e5] bg-white shadow-[0_18px_50px_rgba(35,18,31,0.08)]"
              >
                <form
                  action={deleteSavedImage}
                  className="absolute right-2 top-2 z-10"
                >
                  <input
                    type="hidden"
                    name="imageKey"
                    value={getImageKey(item)}
                  />
                  <button
                    type="submit"
                    aria-label="Delete image"
                    className="flex h-8 w-8 items-center justify-center rounded-md bg-white/90 text-sm font-bold text-[#7a3149] shadow-[0_8px_22px_rgba(35,18,31,0.18)] transition hover:bg-[#7a3149] hover:text-white focus:outline-none focus:ring-4 focus:ring-[#f3b7c8]"
                  >
                    x
                  </button>
                </form>
                <GalleryMedia item={item} />
              </article>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}
