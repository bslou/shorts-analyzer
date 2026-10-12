import Link from "next/link";

export function AppHeader() {
  return (
    <header className="border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Link href="/" className="flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-linear-to-br from-accent to-accent-2 text-xs font-bold text-white">
            RF
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">Shorts Analyzer</p>
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted">
              Powered by Roboflow
            </p>
          </div>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted">
          <Link href="/" className="hover:text-foreground">
            Upload
          </Link>
          <Link href="/analysis" className="hover:text-foreground">
            Dashboard
          </Link>
        </nav>
      </div>
    </header>
  );
}
