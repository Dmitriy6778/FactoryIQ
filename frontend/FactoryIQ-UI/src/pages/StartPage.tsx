import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../components/Auth/AuthContext";
import styles from "../styles/StartPage.module.css";
import logo from "../../assets/images/logo.jpeg";

import {
  Database,
  Server,
  List,
  Settings,
  ActivitySquare,
  BarChart2,
  FileText,
  UserCog,
  Cpu,
  LogOut,
  Scale3D,
} from "lucide-react";

const StartPage: React.FC = () => {
  const navigate = useNavigate();
  const { logout, hasPerm } = useAuth();

  return (
    <div className={styles.page}>
      
      {/* Logout */}
      <div className={styles.logoutContainer}>
        <button
          className={styles.logoutBtn}
          onClick={() => {
            logout();
            navigate("/login");
          }}
        >
          <LogOut size={20} /> Выйти
        </button>
      </div>

      {/* Логотип */}
      <div className={styles.header}>
        <img src={logo} alt="AltaiMai" className={styles.logo} />
        <h1 className={styles.title}>AltaiMai FabrIQ</h1>
        <div className={styles.subtitle}>
          Индустриальная платформа сбора, анализа и визуализации данных
        </div>
      </div>

      {/* Плитки */}
      <div className={styles.tilesGrid}>

        {hasPerm("Servers.View") && (
          <div className={styles.tile} onClick={() => navigate("/opc-servers")}>
            <Server size={40} />
            <span>OPC UA Серверы</span>
          </div>
        )}

        {hasPerm("Polling.View") && (
          <div className={styles.tile} onClick={() => navigate("/polling-tasks")}>
            <ActivitySquare size={40} />
            <span>Задачи опроса PLC</span>
          </div>
        )}

        {hasPerm("Tags.View") && (
          <div className={styles.tile} onClick={() => navigate("/opc-tags")}>
            <List size={40} />
            <span>Переменные OPC UA</span>
          </div>
        )}

        {hasPerm("Analytics.View") && (
          <div className={styles.tile} onClick={() => navigate("/analytics")}>
            <BarChart2 size={40} />
            <span>Аналитика</span>
          </div>
        )}

        {hasPerm("Reports.View") && (
          <div className={styles.tile} onClick={() => navigate("/create-report")}>
            <Database size={40} />
            <span>Отчёты и шаблоны</span>
          </div>
        )}

        {hasPerm("TelegramReports.View") && (
          <div className={styles.tile} onClick={() => navigate("/tg-reports")}>
            <FileText size={40} />
            <span>TELEGRAM отчёты</span>
          </div>
        )}

        {hasPerm("TelegramChannels.View") && (
          <div className={styles.tile} onClick={() => navigate("/tg-channels")}>
            <FileText size={40} />
            <span>Телеграм-каналы</span>
          </div>
        )}

        {hasPerm("UserScreens.View") && (
          <div className={styles.tile} onClick={() => navigate("/user-screens")}>
            <List size={40} />
            <span>Пользовательские экраны</span>
          </div>
        )}

        {/* ⚡ Новая кнопка: Данные автовесов */}
       
          <button
            className={`btn ${styles.fullBtn}`}
            onClick={() => navigate("/weighbridge")}
          >
            <Scale3D size={22} /> Данные автовесов
          </button>
        

        {hasPerm("Settings.Manage") && (
          <div className={styles.tile} onClick={() => navigate("/monitor/services")}>
            <Cpu size={40} />
            <span>Мониторинг служб</span>
          </div>
        )}

        {hasPerm("Settings.Manage") && (
          <div className={styles.tile} onClick={() => navigate("/settings")}>
            <Settings size={40} />
            <span>Настройки системы</span>
          </div>
        )}

        {hasPerm("Users.Manage") && (
          <div className={`${styles.tile} ${styles.adminTile}`} onClick={() => navigate("/settings/users")}>
            <UserCog size={40} />
            <span>Пользователи и права</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default StartPage;
