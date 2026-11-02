import React, { useState, useEffect, useRef } from "react";
import { Key, Eye, EyeOff, Check, AlertCircle, ExternalLink, ShieldCheck } from "lucide-react";

interface ApiKeyInputProps {
  apiKey: string;
  onSaveApiKey: (newKey: string) => void;
  popoverAlign?: "left" | "right";
}

export const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
  apiKey,
  onSaveApiKey,
  popoverAlign = "left",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(apiKey || "");
  const [showKey, setShowKey] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync with prop when prop changes
  useEffect(() => {
    setInputValue(apiKey || "");
  }, [apiKey]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleSave = () => {
    const trimmed = inputValue.trim();
    onSaveApiKey(trimmed);
    setJustSaved(true);
    setTimeout(() => {
      setJustSaved(false);
      setIsOpen(false);
    }, 600);
  };

  const handleClear = () => {
    setInputValue("");
    onSaveApiKey("");
  };

  const hasKey = Boolean(apiKey && apiKey.trim().length > 5);

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      {/* Icon Button in place of image_c62b4324.png */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="relative w-8 h-8 rounded-xl bg-gradient-to-br from-orange-500 via-amber-500 to-emerald-600 hover:opacity-90 active:scale-95 flex items-center justify-center text-white shadow-xs flex-shrink-0 cursor-pointer transition border border-amber-400/30"
        title={hasKey ? "Cài đặt API Key (Đang hoạt động)" : "Nhập API Key để bắt đầu dịch"}
        aria-label="Cài đặt API Key"
      >
        <Key className="w-4 h-4 text-white" />
        {/* Active badge indicator */}
        <span
          className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-white ${
            hasKey ? "bg-emerald-400" : "bg-amber-400 animate-ping"
          }`}
        />
      </button>

      {/* Popover / Modal for entering and toggling hidden API key */}
      {isOpen && (
        <div
          className={`absolute top-10 ${
            popoverAlign === "left" ? "left-0" : "right-0"
          } z-50 bg-white p-4 rounded-2xl shadow-2xl border border-stone-200 w-80 sm:w-96 text-left animate-in fade-in duration-150`}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-extrabold text-xs uppercase tracking-wider text-stone-800 flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-orange-600" />
              API KEY
            </h4>
            <span className="text-[10px] text-stone-400 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-600" />
              Lưu trên thiết bị
            </span>
          </div>

          {/* Input with Show/Hide Toggle */}
          <div className="relative w-full">
            <input
              type={showKey ? "text" : "password"}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSave();
                }
              }}
              placeholder="Dán Gemini API Key vào đây (AIzaSy...)"
              className="w-full pl-3 pr-10 py-2 text-xs border border-stone-300 rounded-xl shadow-inner focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition font-mono bg-stone-50/60"
              aria-label="Gemini API Key"
              autoFocus
            />

            {/* Toggle show/hide password mode */}
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute inset-y-0 right-0 px-2.5 flex items-center text-stone-400 hover:text-stone-700 focus:outline-none cursor-pointer"
              title={showKey ? "Ẩn API Key" : "Hiện API Key"}
              aria-label={showKey ? "Ẩn API Key" : "Hiện API Key"}
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Status info & helper link */}
          <div className="mt-2.5 flex items-center justify-between text-[11px]">
            {hasKey ? (
              <span className="text-emerald-600 flex items-center gap-1 font-semibold">
                <Check className="w-3.5 h-3.5" /> Key đang hoạt động
              </span>
            ) : (
              <span className="text-amber-600 flex items-center gap-1 font-medium">
                <AlertCircle className="w-3.5 h-3.5" /> Chưa nhập key
              </span>
            )}

            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-orange-600 hover:underline flex items-center gap-1 font-medium text-[11px]"
            >
              Lấy key miễn phí <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Footer Actions */}
          <div className="mt-3.5 pt-3 border-t border-stone-100 flex items-center justify-between">
            {hasKey ? (
              <button
                type="button"
                onClick={handleClear}
                className="text-stone-400 hover:text-red-600 text-xs px-2 py-1 transition cursor-pointer font-medium"
              >
                Xóa Key
              </button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-stone-500 hover:text-stone-700 text-xs px-3 py-1.5 rounded-lg transition cursor-pointer"
              >
                Đóng
              </button>
              <button
                type="button"
                onClick={handleSave}
                className={`text-xs font-bold py-1.5 px-4 rounded-xl shadow-xs transition-all flex items-center gap-1.5 cursor-pointer text-white ${
                  justSaved
                    ? "bg-emerald-600"
                    : "bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-700 hover:to-amber-700"
                }`}
              >
                {justSaved ? (
                  <>
                    <Check className="w-3.5 h-3.5" /> Đã lưu
                  </>
                ) : (
                  "Lưu & Kích hoạt"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApiKeyInput;
