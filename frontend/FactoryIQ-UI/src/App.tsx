// client/src/App.tsx
import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import StartPage from "./pages/StartPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import CreateReportPage from "./pages/CreateReportPage";
import SettingsPage from "./pages/SettingsPage";
import OpcServerPage from "./pages/OpcServerPage";
import PollingTasksPage from "./pages/PollingTasksPage";
import OpcTagsPage from "./pages/OpcTagsPage";
import SchedulePage from "./pages/SchedulePage";
import TelegramChannelsPage from "./pages/TelegramChannelsPage";

import LoginPage from "./components/Auth/LoginPage";
import { ProtectedRoute } from "./components/Auth/PermissionGuard";


import SetupWizard from "./components/Auth/SetupWizard";

const App: React.FC = () => (
  <BrowserRouter>
    <Routes>
      {/* ----------- Публичные маршруты ----------- */}
      <Route path="/setup" element={<SetupWizard />} />
      <Route path="/login" element={<LoginPage />} />
      {/* <Route path="/setup" element={<SetupWizard />} /> */}

      {/* ----------- Защищённые маршруты ----------- */}
      <Route
        path="/"
        element={
          <ProtectedRoute anyOf={["Servers.View", "Polling.View", "Tags.View", "Analytics.View"]}>
            <StartPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/analytics"
        element={
          <ProtectedRoute anyOf={["Analytics.View", "Analytics.Run"]}>
            <AnalyticsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/create-report"
        element={
          <ProtectedRoute anyOf={["Reports.Manage", "Reports.View"]}>
            <CreateReportPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/settings"
        element={
          <ProtectedRoute anyOf={["Settings.Manage", "Admin", "Users.Manage"]}>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/opc-servers"
        element={
          <ProtectedRoute anyOf={["Servers.View", "Servers.Manage"]}>
            <OpcServerPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/polling-tasks"
        element={
          <ProtectedRoute anyOf={["Polling.View", "Polling.Manage"]}>
            <PollingTasksPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/opc-tags"
        element={
          <ProtectedRoute anyOf={["Tags.View", "Tags.Manage"]}>
            <OpcTagsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/tg-reports"
        element={
          <ProtectedRoute anyOf={["TelegramReports.View", "TelegramReports.Manage"]}>
            <SchedulePage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/tg-channels"
        element={
          <ProtectedRoute anyOf={["TelegramChannels.View", "TelegramChannels.Manage"]}>
            <TelegramChannelsPage />
          </ProtectedRoute>
        }
      />

      {/* ----------- fallback 404 ----------- */}
      <Route
        path="*"
        element={
          <div style={{ padding: 40 }}>
            <h2>Страница не найдена</h2>
            <p>Проверь адрес или войдите снова.</p>
          </div>
        }
      />
    </Routes>
  </BrowserRouter>
);

export default App;
