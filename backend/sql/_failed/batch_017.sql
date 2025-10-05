IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_OpcData_Status')
    ALTER TABLE dbo.OpcData ADD CONSTRAINT DF_OpcData_Status DEFAULT (N'Good') FOR [Status];
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_OpcTags_DataType')
    ALTER TABLE dbo.OpcTags ADD CONSTRAINT DF_OpcTags_DataType DEFAULT (N'Float') FOR [DataType];
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_PollingTasks_is_active')
    ALTER TABLE dbo.PollingTasks ADD CONSTRAINT DF_PollingTasks_is_active DEFAULT ((1)) FOR is_active;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportDeliveryLog_SentAt')
    ALTER TABLE dbo.ReportDeliveryLog ADD CONSTRAINT DF_ReportDeliveryLog_SentAt DEFAULT (GETDATE()) FOR SentAt;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_Reports_DateCreated')
    ALTER TABLE dbo.Reports ADD CONSTRAINT DF_Reports_DateCreated DEFAULT (GETDATE()) FOR DateCreated;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_Reports_Status')
    ALTER TABLE dbo.Reports ADD CONSTRAINT DF_Reports_Status DEFAULT (N'complete') FOR [Status];
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportSchedule_Active')
    ALTER TABLE dbo.ReportSchedule ADD CONSTRAINT DF_ReportSchedule_Active DEFAULT ((1)) FOR Active;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportStyles_IsDefault')
    ALTER TABLE dbo.ReportStyles ADD CONSTRAINT DF_ReportStyles_IsDefault DEFAULT ((0)) FOR IsDefault;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportStyles_CreatedAt')
    ALTER TABLE dbo.ReportStyles ADD CONSTRAINT DF_ReportStyles_CreatedAt DEFAULT (SYSUTCDATETIME()) FOR CreatedAt;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportStyles_UpdatedAt')
    ALTER TABLE dbo.ReportStyles ADD CONSTRAINT DF_ReportStyles_UpdatedAt DEFAULT (SYSUTCDATETIME()) FOR UpdatedAt;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportTemplates_DateCreated')
    ALTER TABLE dbo.ReportTemplates ADD CONSTRAINT DF_ReportTemplates_DateCreated DEFAULT (GETDATE()) FOR DateCreated;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportTemplates_DateUpdated')
    ALTER TABLE dbo.ReportTemplates ADD CONSTRAINT DF_ReportTemplates_DateUpdated DEFAULT (GETDATE()) FOR DateUpdated;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportTemplates_IsShared')
    ALTER TABLE dbo.ReportTemplates ADD CONSTRAINT DF_ReportTemplates_IsShared DEFAULT ((0)) FOR IsShared;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportTemplates_AutoSchedule')
    ALTER TABLE dbo.ReportTemplates ADD CONSTRAINT DF_ReportTemplates_AutoSchedule DEFAULT ((0)) FOR AutoSchedule;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_ReportTemplateTags_DisplayOrder')
    ALTER TABLE dbo.ReportTemplateTags ADD CONSTRAINT DF_ReportTemplateTags_DisplayOrder DEFAULT ((0)) FOR DisplayOrder;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_TelegramReportTarget_SendAsFile')
    ALTER TABLE dbo.TelegramReportTarget ADD CONSTRAINT DF_TelegramReportTarget_SendAsFile DEFAULT ((1)) FOR SendAsFile;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_TelegramReportTarget_SendAsText')
    ALTER TABLE dbo.TelegramReportTarget ADD CONSTRAINT DF_TelegramReportTarget_SendAsText DEFAULT ((1)) FOR SendAsText;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_TelegramReportTarget_SendAsChart')
    ALTER TABLE dbo.TelegramReportTarget ADD CONSTRAINT DF_TelegramReportTarget_SendAsChart DEFAULT ((0)) FOR SendAsChart;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_TelegramReportTarget_Active')
    ALTER TABLE dbo.TelegramReportTarget ADD CONSTRAINT DF_TelegramReportTarget_Active DEFAULT ((1)) FOR Active;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_TelegramReportTarget_CreatedAt')
    ALTER TABLE dbo.TelegramReportTarget ADD CONSTRAINT DF_TelegramReportTarget_CreatedAt DEFAULT (GETDATE()) FOR CreatedAt;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_Users_CreatedAt')
    ALTER TABLE dbo.Users ADD CONSTRAINT DF_Users_CreatedAt DEFAULT (GETDATE()) FOR CreatedAt;