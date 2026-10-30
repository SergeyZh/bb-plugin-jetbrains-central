import { useId } from "react";
import { jetBrainsPath, providerMarks, type ProviderMark } from "./artwork.js";

export function CentralIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
    <path d={jetBrainsPath} transform="translate(1 1) scale(1.25)" />
  </svg>;
}

export function CentralProviderIcon({ provider, className }: { provider: ProviderMark; className?: string }) {
  const maskId = `central-mark-${useId().replaceAll(":", "")}`;
  const mark = providerMarks[provider];
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <mask id={maskId}>
          <rect width="32" height="32" fill="white" />
          <circle cx="22.5" cy="22.5" r="10" fill="black" />
        </mask>
      </defs>
      <path d={jetBrainsPath} transform="translate(1 1) scale(1.08)" fill="currentColor" mask={`url(#${maskId})`} />
      <circle cx="22.5" cy="22.5" r="9.25" fill={mark.color} />
      <svg x="15.25" y="15.25" width="14.5" height="14.5" viewBox={mark.viewBox} fill="white" fillRule="evenodd">
        {mark.paths.map((path, index) => <path key={index} d={path} />)}
      </svg>
    </svg>
  );
}
