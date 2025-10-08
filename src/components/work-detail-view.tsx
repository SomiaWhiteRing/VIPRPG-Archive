"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import WorkOutline from "@/components/work-outline";
import WorkDetail from "@/components/work-detail";
import type { Festival, WorkEntry } from "@/lib/types";

interface WorkDetailViewProps {
  festival?: Festival;
  works: WorkEntry[];
  activeId: string;
}

export default function WorkDetailView({ festival, works, activeId }: WorkDetailViewProps) {
  const [currentId, setCurrentId] = useState(activeId);

  useEffect(() => {
    setCurrentId(activeId);

    if (typeof window === "undefined") {
      return;
    }

    const currentState = window.history.state as { workId?: string } | null;
    if (currentState?.workId !== activeId) {
      window.history.replaceState({ workId: activeId }, "", window.location.href);
    }
  }, [activeId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handler = (event: PopStateEvent) => {
      const stateId = (event.state as { workId?: string } | null)?.workId;
      if (stateId && works.some((entry) => entry.id === stateId)) {
        setCurrentId(stateId);
        return;
      }

      const pathId = window.location.pathname.split("/").pop();
      if (pathId && works.some((entry) => entry.id === pathId)) {
        setCurrentId(pathId);
      }
    };

    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [works]);

  const handleSelect = useCallback(
    (workId: string) => {
      if (workId === currentId) {
        return;
      }

      if (typeof window !== "undefined") {
        window.history.pushState({ workId }, "", `/works/${workId}`);
      }

      setCurrentId(workId);
    },
    [currentId]
  );

  const currentWork = useMemo(() => {
    if (works.length === 0) {
      return undefined;
    }

    return works.find((entry) => entry.id === currentId) ?? works[0];
  }, [currentId, works]);

  if (!currentWork) {
    return null;
  }

  return (
    <div className="detail-layout">
      <WorkOutline festival={festival} works={works} activeId={currentId} onSelect={handleSelect} />
      <WorkDetail work={currentWork} festival={festival} />
    </div>
  );
}

