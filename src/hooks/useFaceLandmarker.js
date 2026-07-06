import { useEffect, useRef, useState } from "react";
import { normalizeFaceLandmarkerResult } from "../ml/faceLandmarkerResult";

/* MediaPipe Tasks Face Landmarker — 478 landmarks + 52 ARKit-style blendshapes + face pose matrices */
const TASKS_VISION_VERSION = "0.10.21";
const TASKS_VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/vision_bundle.mjs`;
const TASKS_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const FACE_LANDMARKER_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

async function createInlineFaceLandmarker() {
  const mod = await import(/* @vite-ignore */ TASKS_VISION_URL);
  const { FilesetResolver, FaceLandmarker } = mod;
  const fileset = await FilesetResolver.forVisionTasks(TASKS_WASM_BASE);
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    numFaces: 1,
  });
  return {
    mode: "main-thread",
    async detectForVideo(source, timestampMs) {
      return normalizeFaceLandmarkerResult(landmarker.detectForVideo(source, timestampMs));
    },
    close() {
      try { landmarker.close?.(); } catch { /* best-effort model cleanup */ }
    },
  };
}

function supportsWorkerFaceLandmarker() {
  return typeof Worker !== "undefined" && typeof createImageBitmap === "function";
}

function createWorkerRequest(worker, pending, type, payload = {}, transfer = []) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, type, ...payload }, transfer);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

async function createWorkerFaceLandmarker() {
  if (!supportsWorkerFaceLandmarker()) throw new Error("Worker face landmarker is not supported in this browser");
  const worker = new Worker(new URL("../workers/faceLandmarker.worker.js", import.meta.url));
  const pending = new Map();
  let closed = false;

  worker.onmessage = (event) => {
    const { id, type, result, error } = event.data ?? {};
    if (!id || !pending.has(id)) return;
    const request = pending.get(id);
    pending.delete(id);
    if (type === "error" || error) request.reject(new Error(error ?? "Face worker request failed"));
    else request.resolve(result);
  };
  worker.onmessageerror = () => {
    for (const request of pending.values()) request.reject(new Error("Face worker message failed"));
    pending.clear();
  };
  worker.onerror = (event) => {
    for (const request of pending.values()) request.reject(new Error(event?.message ?? "Face worker failed"));
    pending.clear();
  };

  await createWorkerRequest(worker, pending, "init", {
    config: {
      tasksVisionUrl: TASKS_VISION_URL,
      tasksWasmBase: TASKS_WASM_BASE,
      modelAssetPath: FACE_LANDMARKER_MODEL,
    },
  });

  return {
    mode: "worker",
    async detectForVideo(source, timestampMs) {
      if (closed) throw new Error("Face worker is closed");
      const bitmap = await createImageBitmap(source);
      try {
        return await createWorkerRequest(worker, pending, "detect", { timestampMs, bitmap }, [bitmap]);
      } catch (err) {
        try { bitmap.close?.(); } catch { /* bitmap may already be transferred */ }
        throw err;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const request of pending.values()) request.reject(new Error("Face worker closed"));
      pending.clear();
      try { worker.postMessage({ type: "close" }); } catch { /* worker may already be gone */ }
      worker.terminate();
    },
  };
}

async function createFaceLandmarkerService() {
  let detector;
  try {
    detector = await createWorkerFaceLandmarker();
  } catch (err) {
    console.warn("[Mirror] FaceLandmarker worker unavailable, falling back to main thread:", err);
    detector = await createInlineFaceLandmarker();
  }

  let fallbackPromise = null;
  const switchToInline = async (err) => {
    if (fallbackPromise) return fallbackPromise;
    if (detector.mode !== "worker") throw err;
    console.warn("[Mirror] FaceLandmarker worker detection failed, falling back to main thread:", err);
    detector.close();
    fallbackPromise = createInlineFaceLandmarker();
    detector = await fallbackPromise;
    return detector;
  };

  return {
    get mode() { return detector.mode; },
    async detectForVideo(source, timestampMs) {
      try {
        return await detector.detectForVideo(source, timestampMs);
      } catch (err) {
        const fallback = await switchToInline(err);
        return fallback.detectForVideo(source, timestampMs);
      }
    },
    close() {
      detector.close();
    },
  };
}

function useFaceLandmarker(active, retryKey = 0) {
  const [status, setStatus] = useState("idle");
  const [faceLandmarker, setFaceLandmarker] = useState(null);
  const [trackerError, setTrackerError] = useState(null);
  const detectorRef = useRef(null);
  const latestRef = useRef(null); // { landmarks, blendshapes, facialTransformationMatrix }

  useEffect(() => {
    let cancelled = false;
    const closeCurrentDetector = () => {
      try { detectorRef.current?.close?.(); } catch { /* best-effort model cleanup */ }
      detectorRef.current = null;
      latestRef.current = null;
      setFaceLandmarker(null);
    };

    if (!active) {
      closeCurrentDetector();
      setTrackerError(null);
      setStatus("idle");
      return undefined;
    }

    closeCurrentDetector();
    setTrackerError(null);
    setStatus("loading");
    (async () => {
      try {
        const detector = await createFaceLandmarkerService();
        if (cancelled) { detector.close(); return; }
        detectorRef.current = detector;
        setFaceLandmarker(detector);
        setStatus("ready");
      } catch (err) {
        console.warn("[Mirror] FaceLandmarker init failed:", err);
        if (!cancelled) {
          setTrackerError(err?.message || "Tracker unavailable");
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      closeCurrentDetector();
    };
  }, [active, retryKey]);

  useEffect(() => {
    return () => {
      try { detectorRef.current?.close?.(); } catch { /* best-effort model cleanup */ }
      detectorRef.current = null;
      setFaceLandmarker(null);
      latestRef.current = null;
    };
  }, []);

  return { faceLandmarker, latestRef, status, trackerError };
}

export { useFaceLandmarker };
