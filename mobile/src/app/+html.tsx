// Web-only HTML shell for static export (ignored by native builds).
// The default shell emits #root{display:flex} with no width constraint,
// which lets the app column size to its CONTENT on web - rows never wrap
// and the layout overflows the viewport. Pin the root to the viewport
// width here; native screens are clamped by the OS and never see this.
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <meta name="theme-color" content="#09090b" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const css = `
html, body { background: #09090b; }
#root { width: 100%; max-width: 100vw; flex-direction: column; }
#root > * { width: 100%; min-width: 0; }
`;
