import "server-only";
import { ImageResponse } from "next/og";
import { PWA_BACKGROUND } from "./pwa";

/** Image types the icon renderer can draw; another logo (WebP) falls back to the initial. */
const DRAWABLE = new Set(["image/png", "image/jpeg"]);

/**
 * A square PNG app icon: the agency's logo filling the whole square (the phone rounds the corners;
 * the settings ask for a square logo), or its initial in white on the panel's ink when there is no
 * logo it can draw. A maskable initial stays inside the middle of the square, the area every
 * launcher shape leaves visible.
 */
export function renderAppIcon(opts: {
  size: number;
  maskable: boolean;
  name: string;
  logo: { bytes: Buffer; mime: string } | null;
}): ImageResponse {
  const { size, maskable, name, logo } = opts;
  const cacheControl = "public, max-age=3600";
  if (logo && DRAWABLE.has(logo.mime)) {
    const src = `data:${logo.mime};base64,${logo.bytes.toString("base64")}`;
    return new ImageResponse(
      (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: PWA_BACKGROUND }}>
          {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
          <img src={src} width={size} height={size} style={{ objectFit: "cover" }} />
        </div>
      ),
      { width: size, height: size, headers: { "Cache-Control": cacheControl } },
    );
  }
  const initial = (name.trim().charAt(0) || "V").toUpperCase();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#171717",
          color: "#ffffff",
          fontSize: Math.round(size * (maskable ? 0.36 : 0.5)),
          fontWeight: 700,
        }}
      >
        {initial}
      </div>
    ),
    { width: size, height: size, headers: { "Cache-Control": cacheControl } },
  );
}
