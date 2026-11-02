import React, { useEffect, useRef, useState, useCallback } from "react";
import { 
  Mic, 
  MicOff,
  RotateCcw, 
  ArrowRightLeft,
  Copy,
  Check,
} from "lucide-react";
import {
  getSharedMicrophoneStream,
  getSharedInputAudioContext,
  getSharedOutputAudioContext,
  resumeSharedAudioContexts,
} from "../utils/audioStreamManager";
import ApiKeyInput from "./ApiKeyInput";

interface LiveAudioBlob {
  data: string;
  mimeType: string;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// Resample audio from hardware rate (e.g. 44100Hz or 48000Hz) to strictly 16000Hz for Gemini Live API
function resampleTo16k(inputData: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === 16000) return inputData;
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(inputData.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const originIdx = i * ratio;
    const low = Math.floor(originIdx);
    const high = Math.min(low + 1, inputData.length - 1);
    const weight = originIdx - low;
    result[i] = inputData[low] * (1 - weight) + inputData[high] * weight;
  }
  return result;
}

function createBlob(data: Float32Array, sampleRate: number): LiveAudioBlob {
  const resampled = resampleTo16k(data, sampleRate);
  const l = resampled.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, resampled[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return {
    data: encode(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)),
    mimeType: "audio/pcm;rate=16000",
  };
}

export interface TranslationMessage {
  id: string;
  speaker: "user" | "ai";
  text: string;
  pinyin?: string;
  detectedLang?: "zh" | "vi" | "other";
  targetLang?: "zh" | "vi";
  isFinal: boolean;
  timestamp: number;
}

interface BilingualTranslatorViewProps {}

// Detect if string contains Chinese characters
function isChineseText(str: string): boolean {
  return /[\u4e00-\u9fa5]/.test(str);
}

export const BilingualTranslatorView: React.FC<BilingualTranslatorViewProps> = () => {
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("gemini-api-key") || "";
    }
    return "";
  });

  const [status, setStatus] = useState("Đang kết nối AI Dịch 2 Chiều (Việt ⇋ Trung)...");
  const [messages, setMessages] = useState<TranslationMessage[]>([
    {
      id: "welcome-intro",
      speaker: "ai",
      text: "Tôi là phiên dịch của bạn. chúng ta bắt đầu nhé",
      targetLang: "vi",
      isFinal: true,
      timestamp: Date.now(),
    },
  ]);
  const [needsInteraction, setNeedsInteraction] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [isTranslatingText, setIsTranslatingText] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speechRate] = useState<number>(0.95);

  const handleSaveApiKey = useCallback((newKey: string) => {
    const trimmed = newKey.trim();
    if (trimmed) {
      localStorage.setItem("gemini-api-key", trimmed);
      setApiKey(trimmed);
      setStatus("Đã lưu API Key! Đang kết nối dịch...");
    } else {
      localStorage.removeItem("gemini-api-key");
      setApiKey("");
      setStatus("Chưa có API Key. Bấm vào biểu tượng chìa khóa để nhập key.");
    }
    setRetryCount((c) => c + 1);
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTime = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reconnectAttemptsRef = useRef(0);
  const isMutedRef = useRef(false);
  const isTranslatingRef = useRef(false);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Browser speech synthesis playback for manual replay
  const handleSpeakText = useCallback((text: string, langHint?: "zh" | "vi") => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const hasChinese = isChineseText(text);
    if (langHint === "zh" || hasChinese) {
      utterance.lang = "zh-CN";
      utterance.rate = speechRate;
    } else {
      utterance.lang = "vi-VN";
      utterance.rate = speechRate;
    }
    window.speechSynthesis.speak(utterance);
  }, [speechRate]);

  const handleCopyBothLines = (id: string, line1: string, line2: string) => {
    const textToCopy = [line1, line2].filter(Boolean).join("\n").trim();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      }).catch(() => {});
    }
  };

  const cards = React.useMemo(() => {
    interface CardItem {
      id: string;
      line1: string;
      line2: string;
      line1Lang: "zh" | "vi";
      line2Lang: "zh" | "vi";
      pinyin?: string;
      isPending: boolean;
      timestamp: number;
    }
    const result: CardItem[] = [];
    let i = 0;

    while (i < messages.length) {
      const current = messages[i];

      if (current.id === "welcome-intro") {
        result.push({
          id: "welcome-intro",
          line1: "我是您的翻译员，我们开始吧",
          line2: current.text || "Tôi là phiên dịch của bạn. chúng ta bắt đầu nhé",
          line1Lang: "zh",
          line2Lang: "vi",
          pinyin: "wǒ shì nín de fānyì yuán, wǒmen kāishǐ ba",
          isPending: false,
          timestamp: current.timestamp || Date.now(),
        });
        i++;
        continue;
      }

      if (current.speaker === "user") {
        const next = messages[i + 1];
        if (next && next.speaker === "ai") {
          const userIsZh = current.detectedLang === "zh" || isChineseText(current.text);
          result.push({
            id: current.id,
            line1: current.text,
            line2: next.text,
            line1Lang: userIsZh ? "zh" : "vi",
            line2Lang: userIsZh ? "vi" : "zh",
            pinyin: next.pinyin || (userIsZh ? current.pinyin : undefined),
            isPending: !next.isFinal,
            timestamp: current.timestamp,
          });
          i += 2;
        } else {
          const userIsZh = current.detectedLang === "zh" || isChineseText(current.text);
          result.push({
            id: current.id,
            line1: current.text,
            line2: "",
            line1Lang: userIsZh ? "zh" : "vi",
            line2Lang: userIsZh ? "vi" : "zh",
            pinyin: current.pinyin,
            isPending: true,
            timestamp: current.timestamp,
          });
          i++;
        }
      } else {
        const isZh = current.targetLang === "zh" || isChineseText(current.text);
        result.push({
          id: current.id,
          line1: current.text,
          line2: "",
          line1Lang: isZh ? "zh" : "vi",
          line2Lang: isZh ? "vi" : "zh",
          pinyin: current.pinyin,
          isPending: !current.isFinal,
          timestamp: current.timestamp,
        });
        i++;
      }
    }

    return result;
  }, [messages]);

  // High-precision 2-way translation engine via server endpoint (Anti-mistranslation guarantee)
  const translatePreciseText = useCallback(async (
    textToTranslate: string, 
    forcedSourceLang?: "vi" | "zh"
  ): Promise<{ translation: string; pinyin: string; targetLang: "vi" | "zh"; detectedLang: "vi" | "zh" }> => {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-gemini-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        text: textToTranslate,
        sourceLang: forcedSourceLang,
        apiKey: apiKey,
      }),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `Lỗi máy chủ (${res.status})`);
    }

    return await res.json();
  }, [apiKey]);

  // Handle direct translation & vocal response
  const handleProcessSentence = useCallback(async (
    text: string, 
    sourceLang?: "vi" | "zh"
  ) => {
    const trimmed = text.trim();
    if (!trimmed || isTranslatingRef.current) return;

    isTranslatingRef.current = true;
    setIsTranslatingText(true);

    const initialZh = sourceLang ? (sourceLang === "zh") : isChineseText(trimmed);
    const userMsgId = `user-${Date.now()}`;
    const aiMsgId = `ai-${Date.now()}`;

    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        speaker: "user",
        text: trimmed,
        detectedLang: initialZh ? "zh" : "vi",
        isFinal: true,
        timestamp: Date.now(),
      }
    ]);

    setStatus(initialZh ? "Đang dịch sang Tiếng Việt..." : "Đang dịch sang Tiếng Trung...");

    try {
      const result = await translatePreciseText(trimmed, sourceLang);

      // Cập nhật lại ngôn ngữ phát hiện chính xác của người dùng
      if (result.detectedLang) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userMsgId ? { ...m, detectedLang: result.detectedLang } : m
          )
        );
      }

      setMessages((prev) => [
        ...prev,
        {
          id: aiMsgId,
          speaker: "ai",
          text: result.translation,
          pinyin: result.pinyin,
          targetLang: result.targetLang,
          isFinal: true,
          timestamp: Date.now(),
        }
      ]);

      setStatus(result.targetLang === "zh" ? "Đang phát âm Tiếng Trung..." : "Đang phát âm Tiếng Việt...");
      handleSpeakText(result.translation, result.targetLang);

      setTimeout(() => {
        setStatus("Sẵn sàng! Luôn dịch đối đáp 2 chiều (Việt ⇋ Trung).");
      }, 1500);

    } catch (err: any) {
      console.error("Translation error:", err);
      setStatus("Lỗi dịch câu: " + (err?.message || "Vui lòng thử lại."));
    } finally {
      isTranslatingRef.current = false;
      setIsTranslatingText(false);
    }
  }, [translatePreciseText, handleSpeakText]);

  // Setup Live API Connection via Server WebSocket Proxy (Continuous Real-time Speech-to-Speech)
  useEffect(() => {
    let isCleanedUp = false;
    let localInputAudioContext: AudioContext | null = null;
    let localOutputAudioContext: AudioContext | null = null;
    let localScriptProcessor: ScriptProcessorNode | null = null;
    let localWs: WebSocket | null = null;
    let promptSent = false;
    const sources = new Set<AudioBufferSourceNode>();

    const cleanup = () => {
      isCleanedUp = true;
      if (localScriptProcessor) {
        try {
          localScriptProcessor.disconnect();
        } catch {}
      }
      sources.forEach((source) => {
        try {
          source.stop();
        } catch {}
      });
      sources.clear();
      if (localWs) {
        try {
          localWs.close();
        } catch {}
        localWs = null;
      }
      wsRef.current = null;
    };

    const sendTeacherStartPrompt = () => {
      if (promptSent) return;
      const ws = localWs || wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      promptSent = true;
      try {
        ws.send(JSON.stringify({
          type: "initPrompt",
          text: `Bắt đầu phiên dịch 2 chiều. Phát âm đúng câu: "Tôi là phiên dịch của bạn. chúng ta bắt đầu nhé", sau đó sẵn sàng dịch tức thì tiếng Việt và tiếng Trung.`,
        }));
      } catch (err) {
        console.warn("Could not send initial translator prompt:", err);
      }
    };

    const startConversation = async () => {
      try {
        setHasError(false);
        setStatus("Đang chuẩn bị micro...");
        const stream = await getSharedMicrophoneStream();
        if (isCleanedUp) return;

        localInputAudioContext = getSharedInputAudioContext();
        localOutputAudioContext = getSharedOutputAudioContext();
        inputAudioContextRef.current = localInputAudioContext;
        outputAudioContextRef.current = localOutputAudioContext;

        const track = stream.getAudioTracks()[0];
        if (track) {
          track.enabled = true;
        }

        await resumeSharedAudioContexts();

        if (
          localInputAudioContext.state === "suspended" ||
          localOutputAudioContext.state === "suspended"
        ) {
          setStatus("Chạm để kích hoạt âm thanh");
          setNeedsInteraction(true);
        } else {
          setNeedsInteraction(false);
          setStatus("Đang kết nối giáo viên AI phiên dịch...");
        }

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const params = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : "";
        const wsUrl = `${protocol}//${window.location.host}/api/live${params}`;
        const ws = new WebSocket(wsUrl);
        localWs = ws;
        wsRef.current = ws;

        ws.onopen = () => {
          setStatus("Đã kết nối máy chủ! Đang lắng nghe micro để dịch đối đáp...");
          reconnectAttemptsRef.current = 0;

          const source = localInputAudioContext!.createMediaStreamSource(stream);
          const scriptProcessor = localInputAudioContext!.createScriptProcessor(4096, 1, 1);
          localScriptProcessor = scriptProcessor;
          scriptProcessorRef.current = scriptProcessor;

          const currentSampleRate = localInputAudioContext!.sampleRate;

          const muteGain = localInputAudioContext!.createGain();
          muteGain.gain.value = 0;

          scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
            if (isMutedRef.current) return;
            if (localInputAudioContext?.state === "suspended") {
              localInputAudioContext.resume().catch(() => {});
            }
            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
            const pcmBlob = createBlob(inputData, currentSampleRate);

            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({
                  type: "audio",
                  data: pcmBlob.data,
                  mimeType: pcmBlob.mimeType,
                }));
              } catch {
                // Ignore transient network frame drops
              }
            }
          };

          source.connect(scriptProcessor);
          scriptProcessor.connect(muteGain);
          muteGain.connect(localInputAudioContext!.destination);

          setTimeout(() => {
            sendTeacherStartPrompt();
          }, 600);
        };

        ws.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === "open" || data.setupComplete) {
              setStatus("Đã kết nối! Sẵn sàng dịch đối đáp hai chiều...");
              sendTeacherStartPrompt();
            }

            if (data.audio) {
              setStatus("Giáo viên AI đang phát âm câu dịch...");
              const outCtx = outputAudioContextRef.current;
              if (outCtx) {
                nextStartTime.current = Math.max(nextStartTime.current, outCtx.currentTime);
                const audioBuffer = await decodeAudioData(
                  decode(data.audio),
                  outCtx,
                  24000,
                  1
                );
                const source = outCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outCtx.destination);
                source.addEventListener("ended", () => {
                  sources.delete(source);
                });
                source.start(nextStartTime.current);
                nextStartTime.current += audioBuffer.duration;
                sources.add(source);
              }
            }

            if (data.interrupted) {
              sources.forEach((source) => source.stop());
              sources.clear();
              nextStartTime.current = 0;
            }

            if (data.inputTranscription) {
              const text = data.inputTranscription;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                const detected = isChineseText(text) ? "zh" : "vi";
                if (last && last.speaker === "user" && !last.isFinal) {
                  const newMsgs = [...prev];
                  const mergedText = last.text + text;
                  newMsgs[newMsgs.length - 1] = {
                    ...last,
                    text: mergedText,
                    detectedLang: isChineseText(mergedText) ? "zh" : "vi",
                  };
                  return newMsgs;
                } else {
                  const newMsgs = prev.map((m) => ({ ...m, isFinal: true }));
                  newMsgs.push({
                    id: `user-${Date.now()}`,
                    speaker: "user",
                    text: text,
                    detectedLang: detected,
                    isFinal: false,
                    timestamp: Date.now(),
                  });
                  return newMsgs;
                }
              });
            }

            if (data.outputTranscription) {
              let incomingText = data.outputTranscription;
              if (
                incomingText.includes("明白了") || 
                incomingText.includes("请开始讲话") ||
                incomingText.includes("明白")
              ) {
                incomingText = "Tôi là phiên dịch của bạn. chúng ta bắt đầu nhé";
              }

              const isGreeting = 
                incomingText.includes("Tôi là phiên dịch của bạn") || 
                incomingText.includes("chúng ta bắt đầu");

              setMessages((prev) => {
                const hasWelcome = prev.some((m) => m.id === "welcome-intro");
                if (hasWelcome && isGreeting) {
                  return prev.map((m) =>
                    m.id === "welcome-intro"
                      ? {
                          ...m,
                          text: "Tôi là phiên dịch của bạn. chúng ta bắt đầu nhé",
                          targetLang: "vi",
                          isFinal: true,
                        }
                      : m
                  );
                }

                const last = prev[prev.length - 1];
                const targetLang = isChineseText(incomingText) ? "zh" : "vi";
                if (last && last.speaker === "ai" && !last.isFinal) {
                  const newMsgs = [...prev];
                  let mergedText = last.text + incomingText;
                  if (mergedText.includes("明白了") || mergedText.includes("请开始讲话")) {
                    mergedText = "Tôi là phiên dịch của bạn. chúng ta bắt đầu nhé";
                  }
                  newMsgs[newMsgs.length - 1] = {
                    ...last,
                    text: mergedText,
                    targetLang: isChineseText(mergedText) ? "zh" : "vi",
                  };
                  return newMsgs;
                } else {
                  const newMsgs = prev.map((m) => ({ ...m, isFinal: true }));
                  newMsgs.push({
                    id: `ai-${Date.now()}`,
                    speaker: "ai",
                    text: incomingText,
                    targetLang: targetLang,
                    isFinal: false,
                    timestamp: Date.now(),
                  });
                  return newMsgs;
                }
              });
            }

            if (data.turnComplete) {
              setStatus("Đang lắng nghe... Hãy nói tiếng Trung hoặc tiếng Việt!");
              setMessages((prev) =>
                prev.map((m) => ({ ...m, isFinal: true }))
              );
            }

            if (data.type === "need_key") {
              setHasError(true);
              setStatus("Chưa có API Key. Bấm vào biểu tượng chìa khóa để nhập key.");
              return;
            }

            if (data.type === "error") {
              console.error("Live server error:", data.error);
              setHasError(true);
              if (data.error && data.error.toLowerCase().includes("api key")) {
                setStatus("API Key không hợp lệ. Bấm vào biểu tượng chìa khóa để nhập lại.");
              } else {
                setStatus(`Lỗi kết nối AI: ${data.error}`);
              }
            }
          } catch (err) {
            console.error("Error parsing WebSocket message:", err);
          }
        };

        ws.onerror = (e) => {
          console.error("Live WebSocket client error:", e);
          setHasError(true);
          setStatus("Lỗi kết nối Live API.");
        };

        ws.onclose = (closeEvent) => {
          console.log("Live WebSocket closed:", closeEvent.code, closeEvent.reason);
          localWs = null;
          wsRef.current = null;
          if (!isCleanedUp) {
            reconnectAttemptsRef.current += 1;
            const delay = Math.min(800 * Math.pow(1.2, Math.min(reconnectAttemptsRef.current, 5)), 3000);
            setStatus("Đang tự động kết nối lại micro Live...");
            setTimeout(() => {
              if (!isCleanedUp) {
                startConversation();
              }
            }, delay);
          }
        };
      } catch (error: any) {
        console.error("Failed to start translator conversation:", error);
        setHasError(true);
        if (
          error.name === "NotAllowedError" ||
          error.message?.includes("Permission denied")
        ) {
          setStatus("Vui lòng cấp quyền micro trong trình duyệt.");
        } else {
          setStatus("Sẵn sàng dịch! Đang lắng nghe hoặc có thể nhập câu bên dưới.");
        }
      }
    };

    startConversation();

    return cleanup;
  }, [apiKey, retryCount]);

  const handleResumeAudio = async () => {
    if (
      inputAudioContextRef.current &&
      inputAudioContextRef.current.state === "suspended"
    ) {
      await inputAudioContextRef.current.resume();
    }
    if (
      outputAudioContextRef.current &&
      outputAudioContextRef.current.state === "suspended"
    ) {
      await outputAudioContextRef.current.resume();
    }
    setNeedsInteraction(false);
    setStatus("Đang kích hoạt...");
  };

  return (
    <div className="w-full h-full flex flex-col flex-1 min-h-0 relative text-center overflow-hidden bg-gradient-to-b from-amber-50/50 via-white to-orange-50/30">
      
      {/* Audio permission overlay */}
      {needsInteraction && (
        <div
          onClick={handleResumeAudio}
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 rounded-xl backdrop-blur-xs cursor-pointer"
        >
          <button
            onClick={handleResumeAudio}
            className="bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-700 hover:to-amber-700 text-white font-bold py-3.5 px-6 rounded-2xl shadow-xl flex items-center gap-2 transform hover:scale-105 transition-all animate-bounce text-sm sm:text-base"
          >
            <Mic className="w-5 h-5" />
            <span>Chạm để bắt đầu Dịch Đối Đáp 2 Chiều</span>
          </button>
        </div>
      )}

      {/* Hero Header: Status and controls */}
      <div className="flex-shrink-0 pt-1.5 pb-2 px-3 border-b border-amber-200/80 bg-white/95 shadow-2xs">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 max-w-5xl mx-auto">
          
          {/* Main Title Badge */}
          <div className="flex items-center gap-2 min-w-0">
            <ApiKeyInput
              apiKey={apiKey}
              onSaveApiKey={handleSaveApiKey}
              popoverAlign="left"
            />
            <div className="text-left min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs sm:text-sm font-extrabold text-stone-900 tracking-tight">
                  PHIÊN DỊCH (VIỆT ⇋ TRUNG)
                </span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-ping"></span>
                  Luôn dịch 2 chiều • Xuyên suốt
                </span>
              </div>
            </div>
          </div>

          {/* Real-time Status Badge & Controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-stone-100 border border-stone-200 text-xs">
              <span className={`w-2 h-2 rounded-full ${
                status.includes("Lỗi")
                  ? "bg-red-500"
                  : status.includes("Đang lắng nghe") || status.includes("Đã kết nối")
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-amber-500"
              }`} />
              <span className={`text-[11px] font-medium max-w-[180px] sm:max-w-xs truncate ${
                status.includes("Lỗi") ? "text-red-700 font-bold" : "text-stone-700"
              }`}>
                {status}
              </span>
            </div>

            {/* Mute/Unmute icon toggle */}
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`p-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center justify-center ${
                !isMuted
                  ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
                  : "bg-red-50 text-red-700 hover:bg-red-100 border border-red-200"
              }`}
              title={!isMuted ? "Tạm dừng thu âm" : "Tiếp tục thu âm"}
            >
              {!isMuted ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
            </button>

            {(hasError || status.includes("Lỗi") || status.includes("đã đóng")) && (
              <button
                onClick={() => {
                  setHasError(false);
                  setStatus("Đang kết nối lại...");
                  setRetryCount((c) => c + 1);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 active:scale-95 rounded-lg shadow-xs transition cursor-pointer"
                title="Thử kết nối lại"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Thử lại</span>
              </button>
            )}
          </div>

        </div>
      </div>

      {/* Transcript Stream Box */}
      <div className="flex-1 min-h-0 p-3 sm:p-5 overflow-y-auto flex flex-col gap-4 text-left max-w-4xl w-full mx-auto">
        {cards.map((card) => {
          return (
            <div
              key={card.id}
              className="w-full bg-white border-2 border-emerald-500 rounded-2xl sm:rounded-3xl p-4 sm:p-5 shadow-xs hover:shadow-md transition-shadow flex flex-col"
            >
              {/* Line 1 */}
              <div 
                onClick={() => handleSpeakText(card.line1, card.line1Lang)}
                className="font-bold text-stone-900 text-lg sm:text-xl md:text-2xl tracking-normal leading-snug py-1 cursor-pointer hover:text-emerald-700 transition"
                title="Nhấn để nghe phát âm dòng này"
              >
                {card.line1}
              </div>

              {/* Divider 1 */}
              <div className="w-full border-b border-stone-200/90 my-2.5 sm:my-3"></div>

              {/* Line 2 */}
              <div 
                onClick={() => {
                  if (card.line2 && !card.isPending) {
                    handleSpeakText(card.line2, card.line2Lang);
                  }
                }}
                className={`font-bold text-stone-900 text-lg sm:text-xl md:text-2xl tracking-normal leading-snug py-1 ${
                  card.line2 && !card.isPending ? "cursor-pointer hover:text-emerald-700 transition" : ""
                }`}
                title={card.line2 && !card.isPending ? "Nhấn để nghe phát âm dòng này" : ""}
              >
                {card.line2 ? (
                  card.line2
                ) : (
                  <span className="text-stone-400 font-normal italic text-base sm:text-lg animate-pulse flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                    Đang dịch...
                  </span>
                )}
              </div>

              {/* Divider 2 */}
              <div className="w-full border-b border-stone-200/90 my-2.5 sm:my-3"></div>

              {/* Footer Row */}
              <div className="flex items-center text-xs sm:text-sm text-stone-500 pt-0.5 select-none">
                <button
                  onClick={() => handleCopyBothLines(card.id, card.line1, card.line2)}
                  className="flex items-center gap-1.5 hover:text-emerald-700 transition cursor-pointer text-stone-600 font-medium active:scale-95"
                  title="Sao chép"
                >
                  {copiedId === card.id ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      <span className="text-emerald-700 font-semibold">Đã sao chép</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 text-stone-500 flex-shrink-0" />
                      <span>Sao chép</span>
                    </>
                  )}
                </button>
              </div>

            </div>
          );
        })}
        <div ref={scrollRef} />
      </div>

      {/* Bottom Controls: Text input */}
      <div className="flex-shrink-0 bg-white border-t-2 border-amber-300/80 p-2 sm:p-3 shadow-xl">
        <div className="max-w-4xl mx-auto flex flex-col gap-2.5">
          {/* Text input alternative */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleProcessSentence(textInput);
              setTextInput("");
            }}
            className="flex items-center gap-2 w-full"
          >
            <div className="relative flex-1">
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Nhập tiếng Việt (➜ dịch sang Trung) hoặc tiếng Trung (➜ dịch sang Việt)..."
                className="w-full pl-3 pr-8 py-2 text-xs sm:text-sm rounded-xl border border-stone-300 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 bg-stone-50/70 shadow-inner"
              />
              {textInput && (
                <button
                  type="button"
                  onClick={() => setTextInput("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 text-xs font-bold"
                >
                  ✕
                </button>
              )}
            </div>

            <button
              type="submit"
              disabled={!textInput.trim() || isTranslatingText}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-700 hover:to-amber-700 text-white font-bold text-xs shadow-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition cursor-pointer flex-shrink-0"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              <span>Dịch 2 chiều</span>
            </button>
          </form>

        </div>
      </div>

    </div>
  );
};

export default BilingualTranslatorView;
