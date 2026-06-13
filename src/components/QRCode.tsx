import { useMemo } from "react";
import qrcode from "qrcode-generator";

// Self-contained QR (no external service): qrcode-generator builds the module
// matrix, we render it as one crisp SVG path. Deliberately black-on-white with a
// 4-module quiet zone — themed/low-contrast QR fails to scan; a plain code is the
// one thing here that must "just work" pointed at any phone camera.
export function QRCode({ value, size = 160, className }: { value: string; size?: number; className?: string }) {
  const { path, dim } = useMemo(() => {
    const qr = qrcode(0, "M"); // 0 = auto-size to fit; M = ~15% error correction
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4; // standard quiet zone (modules)
    let d = "";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
      }
    }
    return { path: d, dim: count + margin * 2 };
  }, [value]);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for the session invite link"
    >
      <rect width={dim} height={dim} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
