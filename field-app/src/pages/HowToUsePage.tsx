import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { HowToUse, type GuideAudience } from "../guide/howToUse";

export function HowToUsePage() {
  const navigate = useNavigate();
  const [audience, setAudience] = useState<GuideAudience>("field");
  return <HowToUse audience={audience} onAudience={setAudience} onBack={() => navigate(-1)} />;
}
