import React from "react";
import upperTide from "./onboarding-tide-upper.svg";
import lowerTide from "./onboarding-tide-lower.svg";
import "./onboarding-ambient.css";

export function OnboardingAmbient() {
  return (
    <div className="onboarding-ambient" aria-hidden="true">
      <img className="onboarding-ambient-tide onboarding-ambient-tide-upper" src={upperTide} alt="" />
      <img className="onboarding-ambient-tide onboarding-ambient-tide-lower" src={lowerTide} alt="" />
    </div>
  );
}
