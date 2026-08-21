import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { OrchestratorSettings } from "./OrchestratorSettings";
import { ProjectSwitcher } from "./ProjectSwitcher";

export function SetupChrome() {
  const [leftHost, setLeftHost] = useState<HTMLElement | null>(null);
  const [rightHost, setRightHost] = useState<HTMLElement | null>(null);
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
    {rightHost && createPortal(<button onClick={() => setShowAI(true)} className="header-quiet-button">AI</button>, rightHost)}
    {showAI && <OrchestratorSettings onClose={() => setShowAI(false)} />}
  </>;
}
