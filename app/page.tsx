import Image from "next/image";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after, connection } from "next/server";
import {
  appendImagesToArchive,
  fetchFreshTwitterImages,
  getCachedTwitterImages,
  IMAGE_LIMIT,
  isActiveGenerationJob,
  readGenerationJob,
  type GalleryImage,
  writeGenerationJob,
  writeImageCache,
} from "@/lib/twitter-images";
import { GenerationRefresh } from "./generation-refresh";

export const maxDuration = 300;

async function runImageGenerationJob() {
  const currentJob = await readGenerationJob();
  const startedAt = currentJob.startedAt || new Date().toISOString();

  try {
    const freshResult = await fetchFreshTwitterImages(async (progress) => {
      await writeGenerationJob({
        status: "running",
        readyCount: progress.readyCount,
        totalCount: progress.totalCount,
        startedAt,
        message: "Generating a new text-free image batch.",
      });
      revalidatePath("/");
    });

    if (freshResult.images.length === IMAGE_LIMIT) {
      await writeImageCache(freshResult.images);
      await appendImagesToArchive(freshResult.images);
      await writeGenerationJob({
        status: "idle",
        readyCount: IMAGE_LIMIT,
        totalCount: IMAGE_LIMIT,
        finishedAt: new Date().toISOString(),
        message: `Saved ${IMAGE_LIMIT} new text-free images.`,
      });
    } else {
      await writeGenerationJob({
        status: "error",
        readyCount: freshResult.images.length,
        totalCount: IMAGE_LIMIT,
        finishedAt: new Date().toISOString(),
        message:
          freshResult.error ||
          `Only found ${freshResult.images.length} usable image${
            freshResult.images.length === 1 ? "" : "s"
          }; kept the previous cached batch.`,
      });
    }
  } catch (error) {
    await writeGenerationJob({
      status: "error",
      readyCount: 0,
      totalCount: IMAGE_LIMIT,
      finishedAt: new Date().toISOString(),
      message:
        error instanceof Error
          ? error.message
          : "Image generation failed before a full batch was saved.",
    });
  }

  revalidatePath("/");
  revalidatePath("/gallery");
}

async function generateImages() {
  "use server";

  const currentJob = await readGenerationJob();

  if (!isActiveGenerationJob(currentJob)) {
    await writeGenerationJob({
      status: "running",
      readyCount: 0,
      totalCount: IMAGE_LIMIT,
      startedAt: new Date().toISOString(),
      message: "Generating a new text-free image batch.",
    });
    after(runImageGenerationJob);
  }

  revalidatePath("/");
  revalidatePath("/gallery");
  redirect("/");
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

export default async function Home() {
  await connection();

  const { images, error } = await getCachedTwitterImages();
  const generationJob = await readGenerationJob();
  const isGenerating = isActiveGenerationJob(generationJob);
  const jobMessage =
    generationJob.status === "running" && !isGenerating
      ? "The last image generation timed out before a full batch was saved. Try again with the same button."
      : generationJob.message;

  return (
    <main className="min-h-screen bg-[#fbf8fb] text-[#211923]">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-6 border-b border-[#ead9e5] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="mb-3 text-sm font-semibold uppercase text-[#bc0082]">
              Image Pipeline Gallery
            </p>
            <h1 className="max-w-2xl text-4xl font-semibold leading-11 text-[#211923] sm:text-5xl sm:leading-14">
              Images pulled from configured X accounts.
            </h1>
            <form action={generateImages} className="mt-6">
              <button
                type="submit"
                disabled={isGenerating}
                className="rounded-lg bg-[#0fa958] px-8 py-4 text-lg font-bold uppercase tracking-normal text-white shadow-[0_14px_34px_rgba(15,169,88,0.28)] transition hover:bg-[#0b8e4a] focus:outline-none focus:ring-4 focus:ring-[#7ee2ad] disabled:cursor-wait disabled:bg-[#6fba8f]"
              >
                {isGenerating ? "generating" : "generate images!"}
              </button>
            </form>
            <GenerationRefresh active={isGenerating} />
            {isGenerating ? (
              <p className="mt-4 max-w-2xl text-sm font-medium leading-6 text-[#0b8e4a]">
                Generating a new batch. {generationJob.readyCount ?? 0} /{" "}
                {generationJob.totalCount ?? IMAGE_LIMIT} pictures ready.
              </p>
            ) : (generationJob.status === "error" ||
                generationJob.status === "running") &&
              jobMessage ? (
              <p className="mt-4 max-w-2xl text-sm font-medium leading-6 text-[#7a3149]">
                {jobMessage}
              </p>
            ) : error ? (
              <p className="mt-4 max-w-2xl text-sm font-medium leading-6 text-[#7a3149]">
                {error}
              </p>
            ) : null}
          </div>
        </header>

        <section
          aria-label="Configured account image gallery"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {images.map((item) => (
            <article
              key={item.id}
              className="group overflow-hidden rounded-lg border border-[#ead9e5] bg-white shadow-[0_18px_50px_rgba(35,18,31,0.08)]"
            >
              <GalleryMedia item={item} />
            </article>
          ))}
        </section>

        <Link
          href="/gallery"
          className="group flex items-center justify-between gap-4 rounded-lg border border-[#d6e6db] bg-[#f4fbf6] px-5 py-4 text-[#173522] transition hover:border-[#0fa958] hover:bg-[#eaf8ef]"
        >
          <div>
            <p className="text-sm font-semibold uppercase text-[#0b8e4a]">
              Saved gallery
            </p>
          </div>
          <span className="rounded-md bg-[#0fa958] px-4 py-2 text-sm font-bold uppercase text-white transition group-hover:bg-[#0b8e4a]">
            Open
          </span>
        </Link>
      </section>
    </main>
  );
}
