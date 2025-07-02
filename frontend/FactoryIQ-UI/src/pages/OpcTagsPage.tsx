import React, { useEffect, useState } from "react";
import styles from "../styles/OpcTagsPage.module.css";
import BackButton from "../components/BackButton"; // Импортируем кнопку назад
type OpcTag = {
    id: number;
    browse_name: string;
    node_id: string;
    data_type: string;
    description: string;
};

const OpcTagsPage: React.FC = () => {
    const [tags, setTags] = useState<OpcTag[]>([]);

    useEffect(() => {
        fetch("http://localhost:8000/tags/all")
            .then(res => res.json())
            .then(data => setTags(data.items || []));
    }, []);


    return (
        <div className={styles.page}>
            <div className={styles.header}>
                <BackButton />
                <span className={styles.headerIcon}>🏷️</span> Управление OPC UA тегами
            </div>
            <div className={styles.desc}>Просмотр и редактирование описаний тегов из таблицы <b>OpcTags</b></div>
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Имя</th>
                        <th>Node ID</th>
                        <th>Тип</th>
                        <th>Описание</th>
                    </tr>
                </thead>
                <tbody>
                    {tags.map((tag, idx) => (
                        <tr key={tag.id}>
                            <td>{idx + 1}</td>
                            <td>{tag.browse_name}</td>
                            <td className={styles.ellipsis}>{tag.node_id}</td>
                            <td>{tag.data_type}</td>
                            <td>
                                <input
                                    className={styles.input}
                                    value={tag.description ?? ""}
                                    onChange={e => {
                                        const value = e.target.value;
                                        setTags(tags =>
                                            tags.map(t =>
                                                t.id === tag.id ? { ...t, description: value } : t
                                            )
                                        );
                                    }}
                                    onKeyDown={async e => {
                                        if (e.key === "Enter") {
                                            await fetch(`http://localhost:8000/tags/${tag.id}`, {
                                                method: "PUT",
                                                headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ description: tag.description }),
                                            });
                                        }
                                    }}
                                    placeholder="—"
                                />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

};

export default OpcTagsPage;
