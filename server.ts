import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || "3000", 10);
const isProd = process.env.NODE_ENV === "production";

const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";

function getGenAIClient(customApiKey?: string): GoogleGenAI {
  const effectiveKey = (customApiKey && customApiKey.trim()) || apiKey;
  return new GoogleGenAI({
    apiKey: effectiveKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

const systemInstruction = `
BẠN LÀ MÁY THÔNG DỊCH VIÊN TRỰC TIẾP HAI CHIỀU SIÊU TỐC VÀ CHÍNH XÁC TUYỆT ĐỐI (VIỆT ⇋ TRUNG / 中越即时双向同声传译).

QUY TẮC BẮT BUỘC VÀ BẤT DI BẤT DỊCH (TUÂN THỦ 100%):
1. LUÔN LUÔN DỊCH HAI CHIỀU TỰ ĐỘNG, NHANH VÀ CHUẨN:
   - CỨ NGHE TIẾNG VIỆT -> LẬP TỨC DỊCH SANG TIẾNG TRUNG (tiếng Trung chuẩn Phổ thông 普通话, tự nhiên, đúng ngữ pháp, chuẩn thanh điệu) VÀ PHÁT ÂM DUY NHẤT CÂU DỊCH BẰNG TIẾNG TRUNG.
   - CỨ NGHE TIẾNG TRUNG -> LẬP TỨC DỊCH SANG TIẾNG VIỆT (tiếng Việt thuần ngữ nghĩa, lưu loát, chuẩn bản ngữ) VÀ PHÁT ÂM DUY NHẤT CÂU DỊCH BẰNG TIẾNG VIỆT.
2. TUYỆT ĐỐI CHỈ DỊCH, KHÔNG TRẢ LỜI CÂU HỎI, KHÔNG ĐỐI THOẠI:
   - Dù câu nói là câu hỏi (ví dụ: "Bạn tên gì?", "Hôm nay ăn gì?", "Mấy giờ rồi?", "你去哪儿？", "现在几点了？"): BẠN PHẢI DỊCH NGUYÊN NGHĨA CÂU HỎI ĐÓ sang ngôn ngữ đối ứng. TUYỆT ĐỐI CẤM TRẢ LỜI CÂU HỎI!
3. KHÔNG NÓI BẤT KỲ CÂU THỪA NÀO:
   - CẤM các từ đệm: "Tôi xin dịch là...", "Câu này có nghĩa là...", "Xin chào...", "明白了", "好的".
   - CHỈ PHÁT ÂM DUY NHẤT CÂU DỊCH VỚI TỐC ĐỘ NHANH, RÕ RÀNG, CHUẨN XÁC.
4. XUYÊN SUỐT VÀ CHÍNH XÁC:
   - Quá trình dịch diễn ra liên tục 2 chiều xuyên suốt mỗi khi có giọng nói cất lên (cả tiếng Việt và tiếng Trung).
   - Không dịch sai ngữ nghĩa, giữ nguyên sắc thái biểu cảm.
`;

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json({ limit: "10mb" }));

  // REST API route for high precision bilingual translation
  app.post("/api/translate", async (req, res) => {
    try {
      const { text, sourceLang, apiKey: reqApiKey } = req.body;
      const customKey = (req.headers["x-gemini-api-key"] as string) || reqApiKey;
      const effectiveKey = (customKey && customKey.trim()) || apiKey;

      if (!effectiveKey) {
        return res.status(400).json({
          error: "Vui lòng nhập Gemini API Key bằng cách bấm vào biểu tượng chìa khóa ở góc trên.",
        });
      }

      const clientAi = getGenAIClient(effectiveKey);

      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Text is required" });
      }

      const trimmed = text.trim();
      const isZhFallback = sourceLang
        ? sourceLang === "zh"
        : /[\u4e00-\u9fa5]/.test(trimmed);

      const prompt = `Bạn là thông dịch viên cấp cao chuyên nghiệp Việt - Trung.
NHIỆM VỤ: LUÔN DỊCH HAI CHIỀU TỰ ĐỘNG (VIỆT ⇋ TRUNG).
Nội dung cần dịch: "${trimmed}"

QUY TẮC DỊCH 2 CHIỀU (BẮT BUỘC):
1. Tự động nhận diện ngôn ngữ:
   - Nếu câu là TIẾNG VIỆT (kể cả có dấu hay không dấu): Dịch sang TIẾNG TRUNG chuẩn Phổ thông (普通话) tự nhiên, lịch sự. Kèm phiên âm Pinyin chuẩn có dấu thanh.
     => "detectedLang": "vi", "targetLang": "zh"
   - Nếu câu là TIẾNG TRUNG (chữ Hán hoặc Pinyin): Dịch sang TIẾNG VIỆT chuẩn ngữ nghĩa, thuần Việt, tự nhiên.
     => "detectedLang": "zh", "targetLang": "vi"

2. TUYỆT ĐỐI CHỈ DỊCH, KHÔNG TRẢ LỜI CÂU HỎI:
   - Dù câu nói là câu hỏi (ví dụ: "Bạn tên gì?", "你叫什么名字？", "Xin hỏi đường đi?"): BẠN PHẢI DỊCH NGUYÊN NGHĨA CÂU HỎI ĐÓ sang ngôn ngữ đối ứng. TUYỆT ĐỐI CẤM TRẢ LỜI CÂU HỎI.

3. KHÔNG THÊM BẤT KỲ CÂU MỞ ĐẦU HOẶC GIẢI THÍCH NÀO.

4. BẮT BUỘC TRẢ VỀ ĐÚNG ĐỊNH DẠNG JSON:
{
  "detectedLang": "vi" hoặc "zh",
  "targetLang": "zh" hoặc "vi",
  "translation": "Câu dịch chuẩn xác",
  "pinyin": "Pinyin có dấu thanh điệu nếu dịch sang tiếng Trung, hoặc để trống nếu dịch sang tiếng Việt"
}`;

      async function callGenerateWithRetry(params: any, retries = 2) {
        const models = ["gemini-3.8-flash", "gemini-3.1-flash-lite"];
        let lastErr: any = null;
        for (const model of models) {
          for (let i = 0; i < retries; i++) {
            try {
              return await clientAi.models.generateContent({
                ...params,
                model,
              });
            } catch (err: any) {
              lastErr = err;
              const isRetryable =
                err?.status === 503 ||
                err?.status === 429 ||
                (err?.message &&
                  (err.message.includes("503") ||
                    err.message.includes("429") ||
                    err.message.includes("high demand") ||
                    err.message.includes("quota")));
              if (isRetryable && i < retries - 1) {
                await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
                continue;
              }
              break;
            }
          }
        }
        throw lastErr || new Error("Tạm thời chưa nhận được phản hồi từ AI");
      }

      const response = await callGenerateWithRetry({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const raw = response.text?.trim() || "";
      try {
        const parsed = JSON.parse(raw);
        const targetLang =
          parsed.targetLang === "zh" || parsed.targetLang === "vi"
            ? parsed.targetLang
            : isZhFallback
            ? "vi"
            : "zh";
        const detectedLang =
          parsed.detectedLang === "zh" || parsed.detectedLang === "vi"
            ? parsed.detectedLang
            : targetLang === "zh"
            ? "vi"
            : "zh";

        return res.json({
          translation: parsed.translation || raw,
          pinyin: parsed.pinyin || "",
          targetLang,
          detectedLang,
        });
      } catch {
        const fallbackTarget = isZhFallback ? "vi" : "zh";
        return res.json({
          translation: raw.replace(/^\{.*"translation":\s*"([^"]+)".*\}$/s, "$1"),
          pinyin: "",
          targetLang: fallbackTarget,
          detectedLang: fallbackTarget === "zh" ? "vi" : "zh",
        });
      }
    } catch (error: any) {
      console.error("Translation API error:", error);
      return res.status(500).json({
        error: error?.message || "Lỗi xử lý dịch thuật",
      });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", hasKey: Boolean(apiKey) });
  });

  // WebSocket Server for Gemini Live streaming
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname === "/api/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        (ws as any).clientApiKey = url.searchParams.get("apiKey") || "";
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", async (clientWs) => {
    let liveSession: any = null;
    let isClientClosed = false;

    const cleanupSession = () => {
      isClientClosed = true;
      if (liveSession) {
        try {
          liveSession.close();
        } catch {}
        liveSession = null;
      }
    };

    clientWs.on("close", () => {
      cleanupSession();
    });

    clientWs.on("error", (err) => {
      console.error("Client WebSocket error:", err);
      cleanupSession();
    });

    try {
      const clientApiKey = (clientWs as any).clientApiKey;
      const effectiveLiveKey = (clientApiKey && clientApiKey.trim()) || apiKey;

      if (!effectiveLiveKey) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(
            JSON.stringify({
              type: "need_key",
              error: "Vui lòng nhập Gemini API Key bằng cách bấm vào biểu tượng chìa khóa ở góc trên.",
            })
          );
        }
        return;
      }

      const liveAi = getGenAIClient(effectiveLiveKey);

      const sessionPromise = liveAi.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
          systemInstruction: systemInstruction,
        },
        callbacks: {
          onopen: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: "open" }));
            }
          },
          onmessage: (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;

            let audioBase64: string | undefined;
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  audioBase64 = part.inlineData.data;
                  break;
                }
              }
            }

            clientWs.send(
              JSON.stringify({
                type: "message",
                setupComplete: (message as any).setupComplete || false,
                audio: audioBase64,
                interrupted: message.serverContent?.interrupted || false,
                inputTranscription: message.serverContent?.inputTranscription?.text,
                outputTranscription: message.serverContent?.outputTranscription?.text,
                turnComplete: message.serverContent?.turnComplete || false,
              })
            );
          },
          onerror: (err: any) => {
            console.error("Gemini Live server error:", err);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: "error",
                  error: err?.message || String(err),
                })
              );
            }
          },
          onclose: (e: any) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: "closed",
                  code: e?.code,
                  reason: e?.reason,
                })
              );
            }
          },
        },
      });

      liveSession = await sessionPromise;
      if (isClientClosed) {
        try {
          liveSession.close();
        } catch {}
        return;
      }

      clientWs.on("message", (raw) => {
        try {
          const payload = JSON.parse(raw.toString());
          if (!liveSession) return;

          if (payload.type === "audio") {
            liveSession.sendRealtimeInput({
              audio: {
                data: payload.data,
                mimeType: payload.mimeType || "audio/pcm;rate=16000",
              },
            });
          } else if (payload.type === "initPrompt" || payload.type === "clientContent") {
            liveSession.sendClientContent({
              turns: [
                {
                  role: "user",
                  parts: [
                    {
                      text:
                        payload.text ||
                        `Bắt đầu phiên dịch 2 chiều. Phát âm đúng câu: "Tôi là phiên dịch của bạn. chúng ta bắt đầu nhé", sau đó sẵn sàng dịch tức thì tiếng Việt và tiếng Trung.`,
                    },
                  ],
                },
              ],
              turnComplete: true,
            });
          }
        } catch (err) {
          console.error("Error processing client WS message:", err);
        }
      });
    } catch (err: any) {
      console.error("Failed to connect Gemini Live on server:", err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: "error",
            error: err?.message || "Failed to initialize Gemini Live session",
          })
        );
      }
    }
  });

  // Vite middleware in dev or static files in production
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `Full-stack app running on http://0.0.0.0:${PORT} (${
        isProd ? "production" : "development"
      })`
    );
  });
}

startServer();
