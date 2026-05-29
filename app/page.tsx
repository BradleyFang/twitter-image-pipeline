const galleryItems = [
  {
    title: "Chromatic Drift",
    category: "Editorial",
    size: "Standard frame",
  },
  {
    title: "Signal Bloom",
    category: "Campaign",
    size: "Standard frame",
  },
  {
    title: "Night Surface",
    category: "Product",
    size: "Standard frame",
  },
  {
    title: "Soft Geometry",
    category: "Archive",
    size: "Standard frame",
  },
  {
    title: "Glass Index",
    category: "Series",
    size: "Standard frame",
  },
  {
    title: "Violet Field",
    category: "Study",
    size: "Standard frame",
  },
  {
    title: "Quiet Motion",
    category: "Editorial",
    size: "Standard frame",
  },
  {
    title: "Line Memory",
    category: "Archive",
    size: "Standard frame",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#fbf8fb] text-[#211923]">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-6 border-b border-[#ead9e5] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="mb-3 text-sm font-semibold uppercase text-[#bc0082]">
              Image Pipeline Gallery
            </p>
            <h1 className="max-w-2xl text-4xl font-semibold leading-11 text-[#211923] sm:text-5xl sm:leading-14">
              A focused visual gallery ready for incoming image assets.
            </h1>
          </div>
          <div className="grid w-full max-w-sm grid-cols-3 gap-3 text-sm md:text-right">
            <div>
              <p className="font-semibold text-[#bc0082]">08</p>
              <p className="text-[#6f5d69]">Slots</p>
            </div>
            <div>
              <p className="font-semibold text-[#008f8a]">01</p>
              <p className="text-[#6f5d69]">Format</p>
            </div>
            <div>
              <p className="font-semibold text-[#6b7a00]">Ready</p>
              <p className="text-[#6f5d69]">Status</p>
            </div>
          </div>
        </header>

        <section
          aria-label="Image gallery placeholders"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {galleryItems.map((item, index) => (
            <article
              key={item.title}
              className="group relative flex aspect-[4/3] overflow-hidden rounded-lg border border-[#ead9e5] bg-white shadow-[0_18px_50px_rgba(35,18,31,0.08)]"
            >
              <div className="absolute inset-0 bg-[linear-gradient(135deg,#fff7fc_0%,#f8d9ee_38%,#bc0082_100%)] opacity-95" />
              <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(33,25,35,0.12)_1px,transparent_1px),linear-gradient(0deg,rgba(33,25,35,0.12)_1px,transparent_1px)] bg-[size:42px_42px]" />
              <div className="absolute left-0 top-0 h-full w-5 bg-[#00a8a3]/75" />
              <div className="absolute bottom-0 right-0 h-5 w-2/3 bg-[#d5e444]/80" />
              <div className="absolute inset-5 rounded-md border border-white/55 bg-white/18" />
              <div className="absolute inset-x-0 bottom-0 h-2/5 bg-[linear-gradient(0deg,rgba(33,25,35,0.58),transparent)]" />

              <div className="relative flex min-h-full w-full flex-col justify-between p-5">
                <div className="flex items-start justify-between gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[#211923]/90 text-sm font-semibold text-white">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="rounded-md bg-white/80 px-2 py-1 text-[10px] font-semibold uppercase text-[#82305f]">
                    Placeholder
                  </span>
                </div>

                <div className="mt-16">
                  <p className="mb-2 text-sm font-medium text-[#fff7fc] drop-shadow">
                    {item.category}
                  </p>
                  <h2 className="text-2xl font-semibold leading-8 text-white drop-shadow-sm">
                    {item.title}
                  </h2>
                  <p className="mt-2 text-sm font-medium text-white/85">
                    {item.size}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}
