"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Clock } from "lucide-react";
import Composer from "@/components/ui/Composer";
import VideoPlayer from "@/components/ui/VideoPlayer";

type VeoOperationName = string | null;

const POLL_INTERVAL_MS = 5000;

const VeoStudio: React.FC = () => {
  const [prompt, setPrompt] = useState(""); // Video prompt
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [selectedModel, setSelectedModel] = useState(
    "veo-3.0-generate-preview"
  );

  // Imagen-specific prompt
  const [imagePrompt, setImagePrompt] = useState("");

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagenBusy, setImagenBusy] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null); // data URL

  const [operationName, setOperationName] = useState<VeoOperationName>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoBlobRef = useRef<Blob | null>(null);
  const trimmedBlobRef = useRef<Blob | null>(null);
  const trimmedUrlRef = useRef<string | null>(null);
  const originalVideoUrlRef = useRef<string | null>(null);

  const [showImageTools, setShowImageTools] = useState(false);

  const canStart = useMemo(() => {
    if (!prompt.trim()) return false;
    if (showImageTools && !(imageFile || generatedImage)) return false;
    return true;
  }, [prompt, showImageTools, imageFile, generatedImage]);

  const resetAll = () => {
    setPrompt("");
    setNegativePrompt("");
    setAspectRatio("16:9");
    setImagePrompt("");
    setImageFile(null);
    setGeneratedImage(null);
    setOperationName(null);
    setIsGenerating(false);
    setVideoUrl(null);
    if (videoBlobRef.current) {
      URL.revokeObjectURL(URL.createObjectURL(videoBlobRef.current));
      videoBlobRef.current = null;
    }
    if (trimmedUrlRef.current) {
      URL.revokeObjectURL(trimmedUrlRef.current);
      trimmedUrlRef.current = null;
    }
    trimmedBlobRef.current = null;
  };

  // Imagen helper
  const generateWithImagen = useCallback(async () => {
    setImagenBusy(true);
    setGeneratedImage(null);
    try {
      const resp = await fetch("/api/imagen/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: imagePrompt }),
      });
      const json = await resp.json();
      if (json?.image?.imageBytes) {
        const dataUrl = `data:${json.image.mimeType};base64,${json.image.imageBytes}`;
        setGeneratedImage(dataUrl);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setImagenBusy(false);
    }
  }, [imagePrompt]);

  // Start Veo job
  const startGeneration = useCallback(async () => {
    if (!canStart) return;
    setIsGenerating(true);
    setVideoUrl(null);

    const form = new FormData();
    form.append("prompt", prompt);
    form.append("model", selectedModel);
    if (negativePrompt) form.append("negativePrompt", negativePrompt);
    if (aspectRatio) form.append("aspectRatio", aspectRatio);

    if (showImageTools) {
      if (imageFile) {
        form.append("imageFile", imageFile);
      } else if (generatedImage) {
        const [meta, b64] = generatedImage.split(",");
        const mime = meta?.split(";")?.[0]?.replace("data:", "") || "image/png";
        form.append("imageBase64", b64);
        form.append("imageMimeType", mime);
      }
    }

    try {
      const resp = await fetch("/api/veo/generate", {
        method: "POST",
        body: form,
      });
      const json = await resp.json();
      setOperationName(json?.name || null);
    } catch (e) {
      console.error(e);
      setIsGenerating(false);
    }
  }, [
    canStart,
    prompt,
    selectedModel,
    negativePrompt,
    aspectRatio,
    showImageTools,
    imageFile,
    generatedImage,
  ]);

  // Poll operation until done then download (with simple failure backoff)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const maxFailures = 3;

    async function poll() {
      if (!operationName || videoUrl) return;
      try {
        const resp = await fetch("/api/veo/operation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: operationName }),
        });

        if (!resp.ok) {
          // Stop early on client errors; backoff on server errors
          if (resp.status >= 500) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= maxFailures) {
              console.error("Stopping poll after repeated server errors (5xx)");
              setIsGenerating(false);
              return;
            }
          } else {
            let errText: string | undefined;
            try {
              const errJson = await resp.json();
              errText = errJson?.error;
            } catch {}
            console.error(
              "Operation poll failed:",
              resp.status,
              errText || resp.statusText
            );
            setIsGenerating(false);
            return;
          }
        } else {
          const fresh = await resp.json();
          if (fresh?.done) {
            const fileUri = fresh?.response?.generatedVideos?.[0]?.video?.uri;
            if (fileUri) {
              const dl = await fetch("/api/veo/download", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uri: fileUri }),
              });
              const blob = await dl.blob();
              videoBlobRef.current = blob;
              const url = URL.createObjectURL(blob);
              setVideoUrl(url);
              originalVideoUrlRef.current = url;
            }
            setIsGenerating(false);
            return;
          }
        }
      } catch (e) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxFailures) {
          console.error("Stopping poll after repeated network errors", e);
          setIsGenerating(false);
          return;
        }
      } finally {
        if (operationName && !videoUrl && isGenerating) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    }
    if (operationName && !videoUrl) {
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [operationName, videoUrl, isGenerating]);

  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setImageFile(f);
      setGeneratedImage(null);
    }
  };

  const handleTrimmedOutput = (blob: Blob) => {
    trimmedBlobRef.current = blob; // likely webm
    if (trimmedUrlRef.current) {
      URL.revokeObjectURL(trimmedUrlRef.current);
    }
    trimmedUrlRef.current = URL.createObjectURL(blob);
    setVideoUrl(trimmedUrlRef.current);
  };

  const handleResetTrimState = () => {
    if (trimmedUrlRef.current) {
      URL.revokeObjectURL(trimmedUrlRef.current);
      trimmedUrlRef.current = null;
    }
    trimmedBlobRef.current = null;
    if (originalVideoUrlRef.current) {
      setVideoUrl(originalVideoUrlRef.current);
    }
  };

  const downloadVideo = async () => {
    const blob = trimmedBlobRef.current || videoBlobRef.current;
    if (!blob) return;
    const isTrimmed = !!trimmedBlobRef.current;
    const filename = isTrimmed ? "veo3_video_trimmed.webm" : "veo3_video.mp4";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.style.display = "none";
    link.href = url;
    link.setAttribute("download", filename);
    link.setAttribute("rel", "noopener");
    link.target = "_self";
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 0);
  };

  return (
    <div className="relative min-h-screen w-full text-stone-900">
      <div className="absolute top-4 left-4 z-20 hidden md:block">
        <h1 className="text-lg font-semibold text-slate-900/80 backdrop-blur-sm bg-white/20 px-3 py-1 rounded-lg">
          Veo 3
        </h1>
      </div>
      {/* Center hint or video */}
      <div className="flex items-center justify-center min-h-screen pb-40 px-4">
        {!videoUrl &&
          (isGenerating ? (
            <div className="text-stone-700 select-none inline-flex items-center gap-2">
              <Clock className="w-4 h-4 animate-spin" /> Generating Video...
            </div>
          ) : (
            <div className="text-stone-400 select-none">
              Nothing to see here yet.
            </div>
          ))}
        {videoUrl && (
          <div className="w-full max-w-3xl">
            <VideoPlayer
              src={videoUrl}
              onOutputChanged={handleTrimmedOutput}
              onDownload={downloadVideo}
              onResetTrim={handleResetTrimState}
            />
          </div>
        )}
      </div>

      <Composer
        prompt={prompt}
        setPrompt={setPrompt}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        canStart={canStart}
        isGenerating={isGenerating}
        startGeneration={startGeneration}
        showImageTools={showImageTools}
        setShowImageTools={setShowImageTools}
        imagePrompt={imagePrompt}
        setImagePrompt={setImagePrompt}
        imagenBusy={imagenBusy}
        onPickImage={onPickImage}
        generateWithImagen={generateWithImagen}
        imageFile={imageFile}
        generatedImage={generatedImage}
        resetAll={resetAll}
      />
    </div>
  );
};

export default VeoStudio;
