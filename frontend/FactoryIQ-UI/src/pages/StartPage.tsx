import React from "react";
import { useNavigate } from "react-router-dom";
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
} from "lucide-react";

const StartPage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className={styles.startPage}>
      <div className={styles.centerBlock}>
        <div className={`card ${styles.centerCard}`}>
          <div className={styles.logoBlock}>
            <img src={logo} alt="AltaiMai" className={styles.logo} />
            <h1 className="h-title" style={{ textAlign: "center" }}>
              AltaiMai FactoryIQ
            </h1>
          </div>

          <div className={styles.subtitle}>
            Индустриальная платформа сбора, анализа и визуализации данных
          </div>

          <div className={styles.menuGrid}>
            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/opc-servers")}
            >
              <Server size={22} /> OPC UA Серверы
            </button>

            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/polling-tasks")}
            >
              <ActivitySquare size={22} /> Задачи опроса PLC
            </button>

            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/opc-tags")}
            >
              <List size={22} /> Переменные OPC UA
            </button>

            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/analytics")}
            >
              <BarChart2 size={22} /> Аналитика
            </button>

            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/create-report")}
            >
              <Database size={22} /> Отчёты и шаблоны отчётов
            </button>

            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/settings")}
            >
              <Settings size={22} /> Настройки системы
            </button>

            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/tg-reports")}
            >
              <FileText size={22} /> Созданные отчёты TELEGRAM
            </button>
            <button
              className={`btn ${styles.fullBtn}`}
              onClick={() => navigate("/tg-channels")}
            >
              <FileText size={22} /> Телеграм-каналы
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StartPage;
