// TimeContext.tsx
import React, { createContext, useContext } from "react";

export type TimeMode = "live" | "range" | "cursor";

export type TimeRange = {
  from: Date | null;
  to: Date | null;
};

export type TimeContextState = {
  mode: TimeMode;
  range: TimeRange;
  cursor: Date | null;
  windowMinutes: number;
  setMode: (mode: TimeMode) => void;
  setRange: (range: TimeRange) => void;
  setCursor: (cursor: Date | null) => void;
  setWindowMinutes: (minutes: number) => void;
};

const TimeContext = createContext<TimeContextState | undefined>(undefined);

type ProviderProps = {
  value: TimeContextState;
  children: React.ReactNode;
};

export const TimeContextProvider: React.FC<ProviderProps> = ({
  value,
  children,
}) => {
  return (
    <TimeContext.Provider value={value}>{children}</TimeContext.Provider>
  );
};

// --- Safe hook ----
export const useTimeContext = (): TimeContextState => {
  const ctx = useContext(TimeContext);
  if (!ctx) {
    console.warn(
      "[TimeContext] useTimeContext вызван вне TimeContextProvider — возвращаю значения по умолчанию."
    );

    return {
      mode: "live",
      range: {
        from: null,
        to: null,
      },
      cursor: null,
      windowMinutes: 60,
      setMode: () => {},
      setRange: () => {},
      setCursor: () => {},
      setWindowMinutes: () => {},
    };
  }
  return ctx;
};
