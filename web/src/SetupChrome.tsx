import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { HarnessReadinessPanel } from "./HarnessReadinessPanel";
import { OrchestratorSettings } from "./OrchestratorSettings";
import { ProjectSwitcher } from "./ProjectSwitcher";

export function SetupChrome() {
  const [leftHost, setLeftHost] = useState<HTMLElement | null>(null);
  const [rightHost, setRightHost] = useState<HTMLElement | null>(null);
  const [showHarnesses, setShowHarnesses] = useState(false);
  const [showAI, setShowAI] = useState(false);

  useEffect(() => {
    const resolve = () => {
      const header = document.querySelector("#root > div > header");
      if (!(header instanceof HTMLElement)) return;
      const children = Array.from(header.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      setLeftHost(children[0] ?? null);
      setRightHost(children[1] ?? null);
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return <>
    {leftHost && createPortal(<ProjectSwitcher />, leftHost)}
    {rightHost && createPortal(<>
      <button onClick={() => setShowHarnesses(true)} className="header-quiet-button">Agents</button>
      <button onClick={() => setShowAI(true)} className="header-quiet-button">AI</button>
    </>, rightHost)}
    {showHarnesses && <HarnessReadinessPanel onClose={() => setShowHarnesses(false)} />}
    {showAI && <OrchestratorSettings onClose={() => setShowAI(false)} />}
  </>;
}
