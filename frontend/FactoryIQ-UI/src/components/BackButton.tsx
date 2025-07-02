// components/BackButton.tsx
import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import styles from "./BackButton.module.css"; 

const BackButton: React.FC = () => {
    const navigate = useNavigate();
    return (
        <button className={styles.backBtn} onClick={() => navigate("/")}>
            <ArrowLeft size={20} style={{ marginRight: 6 }} />
            На главную
        </button>
    );
};

export default BackButton;
