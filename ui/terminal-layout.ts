/** FitAddon clamps unmeasurable views to 2 columns / 1 row; never resize a PTY to that placeholder. */
export function usableTerminalLayout(
  width: number,
  height: number,
  size: { cols: number; rows: number } | undefined,
): boolean {
  return (
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0 &&
    !!size &&
    Number.isInteger(size.cols) &&
    size.cols > 2 &&
    Number.isInteger(size.rows) &&
    size.rows > 1
  );
}
