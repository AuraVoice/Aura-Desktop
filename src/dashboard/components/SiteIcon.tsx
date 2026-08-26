import { useEffect, useState, type CSSProperties } from "react";
import { siteIcon } from "../../lib/siteIconCache";

/** Stable hue per host, so linkedin.com is always the same blue and
 * crunchbase.com always the same orange. Cheap FNV-style walk over the host. */
function hueFor(host: string): number {
  let hash = 0;
  for (let index = 0; index < host.length; index += 1) {
    hash = (hash * 31 + host.charCodeAt(index)) % 360;
  }
  return hash;
}

/** Two-letter mark shown while the icon loads and for hosts that have none. */
function monogram(host: string, letters: number): string {
  const name = host.split(".")[0] || host;
  return name.slice(0, letters).toUpperCase();
}

/**
 * The favicon for a source's host, falling back to a coloured monogram.
 *
 * The real icon cannot be an `<img>` pointed at a favicon service: the app's
 * CSP allows images from 'self', data: and blob: only. `siteIconCache` pulls
 * the bytes through Rust and hands back a blob URL instead, so the first render
 * of a host is always the monogram and the logo swaps in once it resolves.
 */
export function SiteIcon({
  host,
  size = 18,
  radius = "999px",
  letters = 2,
}: {
  host: string;
  size?: number;
  /** Corner rounding, so a chip can ask for a circle and a list row for a
   * rounded square without either needing its own class. */
  radius?: string;
  letters?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSrc(null);
    void siteIcon(host).then((url) => {
      // Guards a host change mid-flight: a late resolution for the previous
      // host must not paint over the current one.
      if (active) setSrc(url);
    });
    return () => {
      active = false;
    };
  }, [host]);

  const style = {
    "--db-site-icon-size": `${size}px`,
    "--db-site-icon-radius": radius,
    "--db-site-icon-hue": hueFor(host),
  } as CSSProperties;

  if (!src) {
    return (
      <span className="db-site-icon is-mark" style={style} title={host} aria-hidden>
        {monogram(host, letters)}
      </span>
    );
  }
  return (
    <span className="db-site-icon" style={style} title={host} aria-hidden>
      <img src={src} alt="" />
    </span>
  );
}
