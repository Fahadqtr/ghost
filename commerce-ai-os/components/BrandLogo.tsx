// Malika's Universe monogram — a vector "MU" in an elegant serif, so it stays
// razor-sharp at any print size (order cards, QR posters) and in the app card.
// `currentColor` drives the fill, so wrap it in a text-color class to recolor.
// Swap this for the raster logo later by dropping a file at /public/logo.png and
// rendering an <img> instead — the call sites just use <BrandLogo/>.
export default function BrandLogo({
  className = "",
  title = "Malika's Universe",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 230 150"
      className={className}
      role="img"
      aria-label={title}
      fill="currentColor"
    >
      {/* interlocked serif M + U — U's stroke overlaps the M's right leg */}
      <text
        x="88"
        y="122"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', 'Noto Serif', serif"
        fontWeight="700"
        fontSize="130"
      >
        M
      </text>
      <text
        x="150"
        y="122"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', 'Noto Serif', serif"
        fontWeight="700"
        fontSize="130"
      >
        U
      </text>
    </svg>
  );
}
