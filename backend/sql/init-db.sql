

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'tg_user')
BEGIN
    CREATE USER [tg_user] FOR LOGIN [tg_user] WITH DEFAULT_SCHEMA = [dbo];
END
IF NOT EXISTS (
    SELECT 1
    FROM sys.database_role_members rm
    JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id AND r.name = N'db_owner'
    JOIN sys.database_principals u ON rm.member_principal_id = u.principal_id AND u.name = N'tg_user'
)
BEGIN
    ALTER ROLE [db_owner] ADD MEMBER [tg_user];
END
GO


IF OBJECT_ID(N'dbo.OpcServers', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.OpcServers(
        Id             INT            IDENTITY(1,1) NOT NULL,
        Name           NVARCHAR(100)  NOT NULL,
        EndpointUrl    NVARCHAR(250)  NOT NULL,
        Description    NVARCHAR(255)  NULL,
        OpcUsername    NVARCHAR(100)  NULL,
        OpcPassword    NVARCHAR(256)  NULL,
        SecurityPolicy NVARCHAR(50)   NULL,
        SecurityMode   NVARCHAR(32)   NULL,
        CONSTRAINT PK_OpcServers PRIMARY KEY CLUSTERED (Id ASC),
        CONSTRAINT UQ_OpcServers_EndpointUrl UNIQUE NONCLUSTERED (EndpointUrl ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.OpcTags', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.OpcTags(
        Id          INT            IDENTITY(1,1) NOT NULL,
        ServerId    INT            NOT NULL,
        BrowseName  NVARCHAR(200)  NOT NULL,
        NodeId      NVARCHAR(500)  NOT NULL,
        DataType    NVARCHAR(100)  NOT NULL,
        Description NVARCHAR(255)  NULL,
        Path        NVARCHAR(512)  NULL,
        CONSTRAINT PK_OpcTags PRIMARY KEY CLUSTERED (Id ASC)
    );
    CREATE UNIQUE INDEX UX_OpcTags_Server_Node
        ON dbo.OpcTags(ServerId ASC, NodeId ASC);
END
GO

IF OBJECT_ID(N'dbo.OpcData', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.OpcData(
        Id        BIGINT         IDENTITY(1,1) NOT NULL,
        TagId     INT            NOT NULL,
        Value     FLOAT          NOT NULL,
        [Timestamp] DATETIME     NOT NULL,
        [Status]  NVARCHAR(50)   NOT NULL,
        CONSTRAINT PK_OpcData PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.PollingIntervals', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PollingIntervals(
        Id              INT           IDENTITY(1,1) NOT NULL,
        [Name]          NVARCHAR(50)  NOT NULL,
        IntervalSeconds INT           NOT NULL,
        [Type]          NVARCHAR(20)  NULL,
        CONSTRAINT PK_PollingIntervals PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.PollingTasks', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PollingTasks(
        id          INT           IDENTITY(1,1) NOT NULL,
        server_url  NVARCHAR(255) NOT NULL,
        is_active   BIT           NOT NULL,
        started_at  DATETIME      NULL,
        interval_id INT           NOT NULL,
        CONSTRAINT PK_PollingTasks PRIMARY KEY CLUSTERED (id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.PollingTaskTags', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.PollingTaskTags(
        id              INT IDENTITY(1,1) NOT NULL,
        polling_task_id INT NOT NULL,
        tag_id          INT NOT NULL,
        CONSTRAINT PK_PollingTaskTags PRIMARY KEY CLUSTERED (id ASC),
        CONSTRAINT UQ_PollingTaskTag UNIQUE (polling_task_id, tag_id)
    );
END
GO

IF OBJECT_ID(N'dbo.ReportDeliveryLog', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ReportDeliveryLog(
        Id             INT IDENTITY(1,1) NOT NULL,
        ReportId       INT NOT NULL,
        TargetType     NVARCHAR(20) NOT NULL,
        TargetValue    NVARCHAR(255) NOT NULL,
        SentAt         DATETIME NULL,
        DeliveryStatus NVARCHAR(20) NOT NULL,
        ErrorMessage   NVARCHAR(255) NULL,
        CONSTRAINT PK_ReportDeliveryLog PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.Reports', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Reports(
        Id           INT IDENTITY(1,1) NOT NULL,
        TemplateId   INT NOT NULL,
        UserId       INT NOT NULL,
        DateFrom     DATETIME NOT NULL,
        DateTo       DATETIME NOT NULL,
        DateCreated  DATETIME NULL,
        [Status]     NVARCHAR(20) NOT NULL,
        ExportedFile NVARCHAR(255) NULL,
        ExportFormat NVARCHAR(10)  NULL,
        SentTo       NVARCHAR(255) NULL,
        [Comment]    NVARCHAR(255) NULL,
        CONSTRAINT PK_Reports PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.ReportSchedule', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ReportSchedule(
        Id            INT IDENTITY(1,1) NOT NULL,
        TemplateId    INT NOT NULL,
        PeriodType    NVARCHAR(20) NOT NULL,
        TimeOfDay     TIME(7) NOT NULL,
        NextRun       DATETIME NULL,
        LastRun       DATETIME NULL,
        Active        BIT NOT NULL,
        TargetType    NVARCHAR(20) NOT NULL,
        TargetValue   NVARCHAR(255) NOT NULL,
        AggregationType NVARCHAR(20) NULL,
        SendFormat    NVARCHAR(20) NULL,
        CONSTRAINT PK_ReportSchedule PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.ReportStyles', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ReportStyles(
        Id         INT IDENTITY(1,1) NOT NULL,
        [Name]     NVARCHAR(100) NOT NULL,
        ChartStyle NVARCHAR(MAX) NULL,
        TableStyle NVARCHAR(MAX) NULL,
        IsDefault  BIT NOT NULL,
        UserId     INT NULL,
        CreatedAt  DATETIME2(7) NOT NULL,
        UpdatedAt  DATETIME2(7) NOT NULL,
        ExcelStyle NVARCHAR(MAX) NULL,
        CONSTRAINT PK_ReportStyles PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.ReportTemplates', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ReportTemplates(
        Id           INT IDENTITY(1,1) NOT NULL,
        UserId       INT NOT NULL,
        [Name]       NVARCHAR(255) NOT NULL,
        [Description] NVARCHAR(500) NULL,
        DateCreated  DATETIME NULL,
        DateUpdated  DATETIME NULL,
        IsShared     BIT NULL,
        ShareHash    VARCHAR(64) NULL,
        ReportType   NVARCHAR(50) NULL,
        PeriodType   NVARCHAR(20) NULL,
        AutoSchedule BIT NULL,
        TargetChannel NVARCHAR(128) NULL,
        StyleId      INT NULL,
        CONSTRAINT PK_ReportTemplates PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.ReportTemplateTags', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ReportTemplateTags(
        Id              INT IDENTITY(1,1) NOT NULL,
        TemplateId      INT NOT NULL,
        TagId           INT NOT NULL,
        TagType         NVARCHAR(20) NOT NULL,
        [Aggregate]     VARCHAR(16) NULL,
        IntervalMinutes INT NOT NULL,
        DisplayOrder    INT NULL,
        CONSTRAINT PK_ReportTemplateTags PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.TelegramReportTarget', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.TelegramReportTarget(
        Id          INT IDENTITY(1,1) NOT NULL,
        ChannelId   BIGINT NOT NULL,
        ChannelName NVARCHAR(128) NOT NULL,
        ThreadId    INT NULL,
        SendAsFile  BIT NULL,
        SendAsText  BIT NULL,
        SendAsChart BIT NULL,
        Active      BIT NULL,
        CreatedAt   DATETIME NULL,
        CONSTRAINT PK_TelegramReportTarget PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Users(
        Id         INT IDENTITY(1,1) NOT NULL,
        Username   NVARCHAR(100) NOT NULL,
        Email      NVARCHAR(255) NULL,
        TelegramId NVARCHAR(50)  NULL,
        [Role]     NVARCHAR(50)  NULL,
        CreatedAt  DATETIME      NULL,
        CONSTRAINT PK_Users PRIMARY KEY CLUSTERED (Id ASC)
    );
END
GO

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
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_OpcData_Tag')
BEGIN
    ALTER TABLE dbo.OpcData
    ADD CONSTRAINT FK_OpcData_Tag FOREIGN KEY (TagId)
    REFERENCES dbo.OpcTags(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_OpcTags_Server')
BEGIN
    ALTER TABLE dbo.OpcTags
    ADD CONSTRAINT FK_OpcTags_Server FOREIGN KEY (ServerId)
    REFERENCES dbo.OpcServers(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_PollingTasks_Interval')
BEGIN
    ALTER TABLE dbo.PollingTasks
    ADD CONSTRAINT FK_PollingTasks_Interval FOREIGN KEY (interval_id)
    REFERENCES dbo.PollingIntervals(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_PollingTaskTags_Task')
BEGIN
    ALTER TABLE dbo.PollingTaskTags
    ADD CONSTRAINT FK_PollingTaskTags_Task FOREIGN KEY (polling_task_id)
    REFERENCES dbo.PollingTasks(id)
    ON DELETE CASCADE;
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_PollingTaskTags_Tag')
BEGIN
    ALTER TABLE dbo.PollingTaskTags
    ADD CONSTRAINT FK_PollingTaskTags_Tag FOREIGN KEY (tag_id)
    REFERENCES dbo.OpcTags(Id)
    ON DELETE CASCADE;
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_ReportDeliveryLog_Report')
BEGIN
    ALTER TABLE dbo.ReportDeliveryLog
    ADD CONSTRAINT FK_ReportDeliveryLog_Report FOREIGN KEY (ReportId)
    REFERENCES dbo.Reports(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Reports_Template')
BEGIN
    ALTER TABLE dbo.Reports
    ADD CONSTRAINT FK_Reports_Template FOREIGN KEY (TemplateId)
    REFERENCES dbo.ReportTemplates(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Reports_User')
BEGIN
    ALTER TABLE dbo.Reports
    ADD CONSTRAINT FK_Reports_User FOREIGN KEY (UserId)
    REFERENCES dbo.Users(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_ReportSchedule_Template')
BEGIN
    ALTER TABLE dbo.ReportSchedule
    ADD CONSTRAINT FK_ReportSchedule_Template FOREIGN KEY (TemplateId)
    REFERENCES dbo.ReportTemplates(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_ReportTemplates_User')
BEGIN
    ALTER TABLE dbo.ReportTemplates
    ADD CONSTRAINT FK_ReportTemplates_User FOREIGN KEY (UserId)
    REFERENCES dbo.Users(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_ReportTemplates_Style')
BEGIN
    ALTER TABLE dbo.ReportTemplates
    ADD CONSTRAINT FK_ReportTemplates_Style FOREIGN KEY (StyleId)
    REFERENCES dbo.ReportStyles(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_ReportTemplateTags_Tag')
BEGIN
    ALTER TABLE dbo.ReportTemplateTags
    ADD CONSTRAINT FK_ReportTemplateTags_Tag FOREIGN KEY (TagId)
    REFERENCES dbo.OpcTags(Id);
END

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_ReportTemplateTags_Template')
BEGIN
    ALTER TABLE dbo.ReportTemplateTags
    ADD CONSTRAINT FK_ReportTemplateTags_Template FOREIGN KEY (TemplateId)
    REFERENCES dbo.ReportTemplates(Id);
END
GO
