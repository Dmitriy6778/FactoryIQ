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
} from "lucide-react"; // или любые другие иконки

const StartPage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className={styles.startPage}>
      <div className={styles.centerCard}>
        <div className={styles.logoBlock}>
          <img src={logo} alt="AltaiMai" className={styles.logo} />
          <h1 className={styles.title}>FactoryIQ</h1>
        </div>
        <div className={styles.subtitle}>
          Индустриальная платформа сбора, анализа и визуализации данных
          <br />
          <span>OPC UA · SQL </span>
        </div>
        <div className={styles.menuGrid}>
          <button
            className={styles.menuBtn}
            onClick={() => navigate("/opc-servers")}
          >
            <Server size={28} /> OPC UA Серверы
          </button>
          <button
            className={styles.menuBtn}
            onClick={() => navigate("/polling-tasks")}
          >
            <ActivitySquare size={28} /> Мониторинг задач
          </button>
          <button
            className={styles.menuBtn}
            onClick={() => navigate("/opc-tags")}
          >
            <List size={28} /> Теги OPC UA
          </button>
          <button
            className={styles.menuBtn}
            onClick={() => navigate("/analytics")}
          >
            <BarChart2 size={28} /> Аналитика
          </button>
          <button
            className={styles.menuBtn}
            onClick={() => navigate("/create-report")}
          >
            <Database size={28} /> Отчёты
          </button>
          <button
            className={styles.menuBtn}
            onClick={() => navigate("/settings")}
          >
            <Settings size={28} /> Настройки системы
          </button>
          <button
            className={styles.menuBtn}
            onClick={() => navigate("/telegram-reports")}
          >
            <Settings size={28} /> Отчёты TELEGRAM
          </button>
        </div>
        {/* Футер с авторством и названием компании */}
        <div className={styles.footer}>
          <div className={styles.footerContent}>
            <span className={styles.companyName}>
              © {new Date().getFullYear()} MFG Mastermind
            </span>
            <span className={styles.devInfo}>Разработка: Дмитрий Шемелин</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StartPage;
