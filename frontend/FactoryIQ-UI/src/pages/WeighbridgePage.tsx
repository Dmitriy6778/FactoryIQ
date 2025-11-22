// src/pages/WeighbridgePage.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Card,
  DatePicker,
  Select,
  Table,
  Statistic,
  Row,
  Col,
  Spin,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import { useApi } from "../shared/useApi";
import styles from "../styles/WeighbridgePage.module.css";

const { RangePicker } = DatePicker;

/* ---------- Типы ---------- */

type MaterialItem = {
  MaterialName: string;
};

type SummaryDto = {
  NetKgTotal: number | null;
  TripsCount: number;
  MinNetKg: number | null;
  MaxNetKg: number | null;
  AvgNetKg: number | null;
  FirstDate: string | null;
  LastDate: string | null;
};

type ByDayRow = {
  DayDate: string; // '2025-09-03'
  NetKgTotal: number;
  TripsCount: number;
  AvgNetPerTrip: number;
};

type DetailRow = {
  Id: number;
  DateWeight: string;
  CarNumber: string | null;
  MaterialName: string | null;
  Consignor: string | null;
  Consignee: string | null;
  NetKg: number | null;
  PointFrom: string | null;
  PointTo: string | null;
};

/* ---------- Компонент ---------- */

const WeighbridgePage: React.FC = () => {
  const api = useApi();

  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [material, setMaterial] = useState<string | undefined>("подсолнечник");

  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().startOf("year"),
    dayjs().endOf("day"),
  ]);

  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [byDay, setByDay] = useState<ByDayRow[]>([]);
  const [detail, setDetail] = useState<DetailRow[]>([]);

  /* ---------- Helpers ---------- */

  const dateFrom = useMemo(
    () =>
      dateRange ? dateRange[0].startOf("day").toISOString() : undefined,
    [dateRange]
  );

  const dateTo = useMemo(
    () =>
      dateRange
        ? dateRange[1].add(1, "day").startOf("day").toISOString()
        : undefined,
    [dateRange]
  );

  const tons = (kg: number | null | undefined): number =>
    kg != null ? Number((kg / 1000).toFixed(3)) : 0;

  /* ---------- Загрузка материалов ---------- */

  useEffect(() => {
    const loadMaterials = async () => {
      try {
        // useApi.get уже возвращает data
        const res = await api.get("/weighbridge/materials");
        setMaterials(res.items || []);
      } catch (e) {
        console.error(e);
        message.error("Не удалось загрузить список материалов");
      }
    };
    loadMaterials();
  }, [api]);

  /* ---------- Загрузка данных по фильтрам ---------- */

  const loadData = async () => {
    if (!dateRange) {
      message.warning("Укажите период");
      return;
    }

    setLoading(true);
    try {
      const params = {
        date_from: dateFrom,
        date_to: dateTo,
        material_name: material,
      };

      const [summaryRes, byDayRes, detailRes] = await Promise.all([
        api.get("/weighbridge/sunflower/summary", { params }),
        api.get("/weighbridge/sunflower/by-day", { params }),
        api.get("/weighbridge/sunflower/detail", { params }),
      ]);

      // summaryRes / byDayRes / detailRes уже data
      setSummary((summaryRes as any).summary || null);
      setByDay((byDayRes as any).items || []);
      setDetail((detailRes as any).items || []);
    } catch (e) {
      console.error(e);
      message.error("Ошибка загрузки данных автовесов");
    } finally {
      setLoading(false);
    }
  };

  // первая загрузка и перезапрос при изменении фильтров
  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, dateFrom, dateTo]);

  /* ---------- Колонки таблиц ---------- */

  const dayColumns: ColumnsType<ByDayRow & { key: React.Key }> = [
    {
      title: "Дата",
      dataIndex: "DayDate",
      render: (v: string) => dayjs(v).format("DD.MM.YYYY"),
    },
    {
      title: "Нетто, т",
      dataIndex: "NetKgTotal",
      align: "right",
      render: (v: number) => tons(v),
    },
    {
      title: "Рейсов",
      dataIndex: "TripsCount",
      align: "right",
    },
    {
      title: "Среднее нетто за рейс, т",
      dataIndex: "AvgNetPerTrip",
      align: "right",
      render: (v: number) => tons(v),
    },
  ];

  const detailColumns: ColumnsType<DetailRow & { key: React.Key }> = [
    {
      title: "Дата/время",
      dataIndex: "DateWeight",
      render: (v: string) => dayjs(v).format("DD.MM.YYYY HH:mm"),
      width: 160,
    },
    {
      title: "Машина",
      dataIndex: "CarNumber",
      width: 110,
    },
    {
      title: "Поставщик",
      dataIndex: "Consignor",
      width: 180,
    },
    {
      title: "Получатель",
      dataIndex: "Consignee",
      width: 180,
    },
    {
      title: "Нетто, т",
      dataIndex: "NetKg",
      align: "right",
      render: (v: number | null) => (v != null ? tons(v) : null),
      width: 110,
    },
    {
      title: "Откуда",
      dataIndex: "PointFrom",
      width: 140,
    },
    {
      title: "Куда",
      dataIndex: "PointTo",
      width: 140,
    },
  ];

  /* ---------- Render ---------- */

  return (
    <div className={styles.page}>
      <Card className={styles.filterCard}>
        <Row gutter={16} align="middle">
          <Col xs={24} md={10}>
            <span className={styles.filterLabel}>Период:&nbsp;</span>
            <RangePicker
              value={dateRange}
              onChange={(val) => setDateRange(val as [Dayjs, Dayjs] | null)}
              format="DD.MM.YYYY"
              allowClear={false}
            />
          </Col>

          <Col xs={24} md={8}>
            <span className={styles.filterLabel}>Материал:&nbsp;</span>
            <Select
              style={{ minWidth: 220 }}
              value={material}
              onChange={(val) => setMaterial(val)}
              showSearch
              optionFilterProp="children"
            >
              {materials.map((m) => (
                <Select.Option key={m.MaterialName} value={m.MaterialName}>
                  {m.MaterialName}
                </Select.Option>
              ))}
            </Select>
          </Col>
        </Row>
      </Card>

      <Spin spinning={loading}>
        <Row gutter={16} className={styles.topRow}>
          <Col xs={24} md={8}>
            <Card title="Итог по периоду">
              <Row gutter={16}>
                <Col span={24}>
                  <Statistic
                    title="Общий нетто, т"
                    value={summary ? tons(summary.NetKgTotal) : 0}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="Рейсов"
                    value={summary?.TripsCount || 0}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="Среднее нетто за рейс, т"
                    value={
                      summary && summary.AvgNetKg
                        ? tons(summary.AvgNetKg)
                        : 0
                    }
                  />
                </Col>
              </Row>
            </Card>
          </Col>

          <Col xs={24} md={16}>
            <Card title="Поступление по дням">
              <Table
                size="small"
                dataSource={byDay.map((r, i) => ({ ...r, key: i }))}
                columns={dayColumns}
                pagination={{ pageSize: 15 }}
              />
            </Card>
          </Col>
        </Row>

        <Card title="Детальные рейсы" className={styles.bottomCard}>
          <Table
            size="small"
            dataSource={detail.map((r) => ({ ...r, key: r.Id }))}
            columns={detailColumns}
            scroll={{ x: 900, y: 400 }}
          />
        </Card>
      </Spin>
    </div>
  );
};

export default WeighbridgePage;
