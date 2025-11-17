import React, { useEffect, useState, useCallback } from "react";
import { Card, Table, Tag, Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useApi } from "../shared/useApi";
import BackButton from "../components/BackButton";

type ServiceRow = {
  name: string;
  state: string;
};

const ServiceMonitorPage: React.FC = () => {
  const api = useApi();
  const [data, setData] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/system/services");
      // поддерживаем оба варианта: {ok, services} или axios-стиль {data: {...}}
      const payload = (res?.data ?? res) as any;
      if (payload?.ok && Array.isArray(payload?.services)) {
        setData(payload.services as ServiceRow[]);
      } else if (Array.isArray(payload)) {
        setData(payload as ServiceRow[]);
      } else {
        setData([]);
      }
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return (
    <div style={{ padding: 16 }}>
      <BackButton />
      <Card
        title="Службы FactoryIQ"
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={fetchStatus}
            loading={loading}
            disabled={loading}
          >
            Обновить
          </Button>
        }
      >
        <Table<ServiceRow>
          dataSource={data}
          rowKey="name"
          pagination={false}
          columns={[
            { title: "Служба", dataIndex: "name", key: "name" },
            {
              title: "Статус",
              dataIndex: "state",
              key: "state",
              render: (s: string) =>
                s === "RUNNING" ? (
                  <Tag color="green">RUNNING</Tag>
                ) : s === "STOPPED" ? (
                  <Tag color="red">STOPPED</Tag>
                ) : (
                  <Tag color="orange">{s || "UNKNOWN"}</Tag>
                ),
            },
          ]}
          loading={loading}
        />
      </Card>
    </div>
  );
};

export default ServiceMonitorPage;
