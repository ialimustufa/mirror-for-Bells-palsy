import { useCallback, useEffect, useRef, useState } from "react";

export function useCameraStream(enabled, retryKey = 0) {
  const [stream, setStream] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const streamRef = useRef(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setStream(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopStream();
      setCameraError(null);
      return undefined;
    }

    let active = true;
    stopStream();
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is not available in this browser.");
      return () => { active = false; };
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((nextStream) => {
        if (!active) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stopStream();
        streamRef.current = nextStream;
        setStream(nextStream);
        setCameraError(null);
      })
      .catch((err) => {
        if (active) setCameraError(err.message || "Camera unavailable");
      });

    return () => { active = false; };
  }, [enabled, retryKey, stopStream]);

  useEffect(() => stopStream, [stopStream]);

  return { stream, cameraError };
}
