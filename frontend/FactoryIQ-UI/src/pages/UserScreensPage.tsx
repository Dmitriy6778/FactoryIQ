// src/pages/UserScreensPage.tsx
import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Table,
  Button,
  Tag,
  Space,
  Modal,
  Form,
  Input,
  Switch,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  EyeOutlined,
  CopyOutlined,
  DeleteOutlined,
  LockOutlined,
  UnlockOutlined,
  BgColorsOutlined,
  PlusOutlined,
} from "@ant-design/icons";

import BackButton from "../components/BackButton";
import { useApi } from "../shared/useApi";
import { useAuth } from "../components/Auth/AuthContext";

type UserScreenApi = any;

type UserScreen = {
  id: number;
  screenName: string;
  title: string;
  description: string;
  isPublic: boolean;
  isReadonly: boolean;
  bgColor?: string | null;
  ownerUsername?: string | null;
  createdAt?: string | null;
};

type NewScreenFormValues = {
  title: string;
  description?: string;
  bgColor: string;
  isPublic: boolean;
  isReadonly: boolean;
};

const DEFAULT_BG = "#f8fcfe";

const mapScreen = (raw: UserScreenApi): UserScreen => {
  return {
    id: raw.screen_id ?? raw.ScreenId,
    screenName: raw.screen_name ?? raw.ScreenName ?? "",
    title: raw.title ?? raw.Title ?? "",
    description: raw.description ?? raw.Description ?? "",
    isPublic: Boolean(raw.is_public ?? raw.IsPublic),
    isReadonly: Boolean(raw.is_readonly ?? raw.IsReadonly),
    bgColor: raw.bg_color ?? raw.BgColor ?? null,
    ownerUsername: raw.owner_username ?? raw.OwnerUsername ?? null,
    createdAt:
      raw.created_at ??
      raw.CreatedAt ??
      (typeof raw.CreatedAt === "string" ? raw.CreatedAt : null),
  };
};

const UserScreensPage: React.FC = () => {
  const api = useApi();
  const navigate = useNavigate();
  const { hasPerm } = useAuth();

  const [screens, setScreens] = useState<UserScreen[]>([]);
  const [loading, setLoading] = useState(false);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [form] = Form.useForm<NewScreenFormValues>();

  const canManage = hasPerm("UserScreens.Manage") || hasPerm("Admin");

  const loadScreens = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserScreenApi[]>("/user-screens");
      setScreens((data || []).map(mapScreen));
    } catch (e) {
      console.error(e);
      message.error("Не удалось загрузить пользовательские экраны");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadScreens();
  }, [loadScreens]);

  const openCreateModal = () => {
    form.setFieldsValue({
      title: "",
      description: "",
      bgColor: DEFAULT_BG,
      isPublic: false,
      isReadonly: false,
    });
    setIsCreateModalOpen(true);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const body = {
        title: values.title,
        description: values.description || "",
        bgColor: values.bgColor || DEFAULT_BG,
        isPublic: values.isPublic,
        isReadonly: values.isReadonly,
      };

      const res = await api.post<any>("/user-screens", body);
      message.success("Экран создан");
      setIsCreateModalOpen(false);
      await loadScreens();

      const newId =
        res?.screen_id ??
        res?.server_id ??
        res?.ScreenId ??
        res?.id ??
        res?.screenId;
      if (newId) {
        navigate(`/user-screens/${newId}`);
      }
    } catch (e: any) {
      if (e?.errorFields) return; // ошибки формы
      console.error(e);
      message.error("Ошибка создания экрана");
    }
  };

  const handleDelete = async (screen: UserScreen) => {
    Modal.confirm({
      title: `Удалить экран «${screen.title || screen.screenName}»?`,
      okText: "Удалить",
      cancelText: "Отмена",
      okType: "danger",
      onOk: async () => {
        try {
          await api.del(`/user-screens/${screen.id}`);
          message.success("Экран удалён");
          await loadScreens();
        } catch (e) {
          console.error(e);
          message.error("Ошибка удаления экрана");
        }
      },
    });
  };


  const handleClone = async (screen: UserScreen) => {
    try {
      const res = await api.post<any>(`/user-screens/${screen.id}/clone`);
      message.success("Экран склонирован");
      await loadScreens();

      const newId =
        res?.ScreenId ??
        res?.screen_id ??
        res?.id ??
        res?.screenId;
      if (newId) {
        navigate(`/user-screens/${newId}`);
      }
    } catch (e) {
      console.error(e);
      message.error("Ошибка клонирования экрана");
    }
  };

  const handleTogglePublic = async (screen: UserScreen) => {
    try {
      await api.post(`/user-screens/${screen.id}/share`, {
        isPublic: !screen.isPublic,
      });
      message.success(
        !screen.isPublic
          ? "Экран стал публичным"
          : "Экран сделан приватным"
      );
      await loadScreens();
    } catch (e) {
      console.error(e);
      message.error("Не удалось изменить публичность");
    }
  };

  const handleToggleReadonly = async (screen: UserScreen) => {
    try {
      await api.post(`/user-screens/${screen.id}/readonly`, {
        isReadonly: !screen.isReadonly,
      });
      message.success(
        !screen.isReadonly
          ? "Экран переведён в режим 'только чтение'"
          : "Режим 'только чтение' выключен"
      );
      await loadScreens();
    } catch (e) {
      console.error(e);
      message.error("Не удалось изменить режим 'только чтение'");
    }
  };

  const columns: ColumnsType<UserScreen> = [
    {
      title: "Название",
      dataIndex: "title",
      key: "title",
      width: 260,
      render: (text, record) => (
        <span>
          {text || record.screenName}
          {record.bgColor && (
            <BgColorsOutlined
              style={{
                marginLeft: 8,
                color: record.bgColor,
              }}
            />
          )}
        </span>
      ),
    },
    {
      title: "Автор",
      dataIndex: "ownerUsername",
      key: "ownerUsername",
      width: 160,
      render: (v) => v || "—",
    },
    {
      title: "Доступ",
      key: "access",
      width: 220,
      render: (_, record) => (
        <Space size="small">
          {record.isPublic ? (
            <Tag color="green">
              <UnlockOutlined /> Публичный
            </Tag>
          ) : (
            <Tag color="red">
              <LockOutlined /> Приватный
            </Tag>
          )}
          {record.isReadonly && <Tag color="gold">ReadOnly</Tag>}
        </Space>
      ),
    },
    {
      title: "Действия",
      key: "actions",
      width: 320,
      render: (_, record) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/user-screens/${record.id}`)}
          >
            Открыть
          </Button>

          {canManage && (
            <>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => handleClone(record)}
              >
                Клон
              </Button>

              <Button
                size="small"
                icon={record.isPublic ? <LockOutlined /> : <UnlockOutlined />}
                onClick={() => handleTogglePublic(record)}
              >
                {record.isPublic ? "Сделать приватным" : "Сделать публичным"}
              </Button>

              <Button
                size="small"
                onClick={() => handleToggleReadonly(record)}
              >
                {record.isReadonly ? "Разрешить редактирование" : "Только чтение"}
              </Button>

              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                onClick={() => handleDelete(record)}
              >
                Удалить
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 16,
          gap: 12,
        }}
      >
        <BackButton />
        <h2 style={{ margin: 0 }}>Пользовательские экраны</h2>
        <div style={{ flex: 1 }} />
        {canManage && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={openCreateModal}
          >
            Новый экран
          </Button>
        )}
      </div>

      <Table<UserScreen>
        rowKey={(r) => r.id}
        loading={loading}
        dataSource={screens}
        columns={columns}
        size="middle"
        pagination={{ pageSize: 10 }}
      />

      {/* Модалка создания экрана */}
      <Modal
        title="Создать новый экран"
        open={isCreateModalOpen}
        onOk={handleCreate}
        onCancel={() => setIsCreateModalOpen(false)}
        okText="Создать"
        cancelText="Отмена"
        destroyOnClose
      >
        <Form<NewScreenFormValues> layout="vertical" form={form}>
          <Form.Item
            label="Название экрана"
            name="title"
            rules={[{ required: true, message: "Введите название экрана" }]}
          >
            <Input maxLength={80} />
          </Form.Item>

          <Form.Item label="Описание" name="description">
            <Input maxLength={200} />
          </Form.Item>

          <Form.Item label="Цвет фона" name="bgColor">
            <Input type="color" />
          </Form.Item>

          <Form.Item noStyle>
            <Space size="large" style={{ marginTop: 8 }}>
              <Form.Item name="isPublic" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
              <span>Публичный</span>

              <Form.Item name="isReadonly" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
              <span>Только чтение</span>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default UserScreensPage;
