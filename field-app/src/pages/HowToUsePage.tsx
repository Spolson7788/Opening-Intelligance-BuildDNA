import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HowToUse, type GuideAudience } from "../guide/howToUse";
import { fieldBuildLabel } from "../lib/buildStamp";

export function HowToUsePage() {
  const navigate = useNavigate();
  const [audience, setAudience] = useState<GuideAudience>("field");
  return <div className="app-shell c04"><HowToUse audience={audience} onAudience={setAudience} onBack={() => navigate(-1)} /><p className="field-build screen" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{fieldBuildLabel(true)}</p></div>;
}
