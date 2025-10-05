import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import OpcServerPage from "./pages/OpcServerPage";
import PollingTasksPage from "./pages/PollingTasksPage";
import OpcTagsPage from "./pages/OpcTagsPage";
import SettingsPage from "./pages/SettingsPage";
import StartPage from "./pages/StartPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import CreateReportPage from "./pages/CreateReportPage"; // Если нужно, раскомментируй
import SchedulePage from "./pages/SchedulePage";
import TelegramChannelsPage from "./pages/TelegramChannelsPage";
const App: React.FC = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<StartPage />} />
      <Route path="/analytics" element={<AnalyticsPage />} />
      <Route path="/create-report" element={<CreateReportPage />} />
      {/* Если нужно, раскомментируй */}
      {/* <Route path="/create-report" element={<CreateReportPage />} /> */}
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/opc-servers" element={<OpcServerPage />} />
      <Route path="/polling-tasks" element={<PollingTasksPage />} />
      <Route path="/opc-tags" element={<OpcTagsPage />} />
      <Route path="/tg-reports" element={<SchedulePage />} />
      <Route path="/tg-channels" element={<TelegramChannelsPage />} />
      {/* Здесь можешь добавить другие страницы, например */}
      {/* <Route path="/settings" element={<SettingsPage />} /> */}
    </Routes>
  </BrowserRouter>
);

export default App;
