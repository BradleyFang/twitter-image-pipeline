"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type GenerationRefreshProps = {
  active: boolean;
};

export function GenerationRefresh({ active }: GenerationRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    if (!active) {
      return;
    }

    const intervalId = window.setInterval(() => {
      router.refresh();
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [active, router]);

  return null;
}
