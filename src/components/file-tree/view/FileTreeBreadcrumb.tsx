type FileTreeBreadcrumbProps = {
  currentPath: string;
  projectPath: string;
  onNavigate: (path: string) => void;
};

export default function FileTreeBreadcrumb({
  currentPath,
  projectPath,
  onNavigate,
}: FileTreeBreadcrumbProps) {
  const segments = currentPath.split('/').filter(Boolean);
  const cumulativePaths = segments.map((_, i) => '/' + segments.slice(0, i + 1).join('/'));

  return (
    <div
      className="px-2 bg-background border-b border-border text-xs font-mono whitespace-nowrap overflow-x-auto select-none"
      style={{ lineHeight: '1.8' }}
    >
      <span
        onClick={() => onNavigate('/')}
        title="/"
        className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
      >
        /
      </span>
      {segments.map((seg, i) => {
        const segPath = cumulativePaths[i];
        const isCurrent = i === segments.length - 1;
        const isProjectRoot = segPath === projectPath;

        return (
          <span key={segPath}>
            <span
              onClick={() => !isCurrent && onNavigate(segPath)}
              title={segPath}
              className={
                isCurrent
                  ? 'text-cyan-400 font-bold cursor-default'
                  : isProjectRoot
                  ? 'text-blue-400 hover:text-blue-200 cursor-pointer transition-colors'
                  : 'text-muted-foreground hover:text-foreground cursor-pointer transition-colors'
              }
            >
              {seg}
            </span>
            {!isCurrent && (
              <span className="text-muted-foreground/50">/</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
