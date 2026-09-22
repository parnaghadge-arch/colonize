import { useState, type CSSProperties } from 'react';

/**
 * A society's logo at any size — the server always stores a square (512×512) image, so the
 * fallback (the first letter) is the only non-image shape this component ever has to render.
 * The letter sits *behind* the image: a broken or still-loading URL degrades to the letter
 * instead of an empty box.
 */
export function SocietyLogo({
  logoUrl,
  name,
  size = 40,
  radius = 10,
}: {
  logoUrl?: string | null;
  name?: string | null;
  size?: number;
  radius?: number;
}) {
  const [broken, setBroken] = useState(false);
  const initial = (name ?? '').trim().charAt(0).toUpperCase() || 'S';
  const box: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    flex: '0 0 auto',
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    background: 'var(--brand-soft)',
    color: 'var(--brand-dark)',
    border: '1px solid var(--border)',
  };
  const imgStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  };
  return (
    <span style={box} aria-label={`${name ?? 'Society'} logo`}>
      <span style={{ fontSize: Math.round(size * 0.42), fontWeight: 700, userSelect: 'none' }} aria-hidden>
        {initial}
      </span>
      {logoUrl && !broken ? (
        <img src={logoUrl} alt="" style={imgStyle} onError={() => setBroken(true)} />
      ) : null}
    </span>
  );
}
