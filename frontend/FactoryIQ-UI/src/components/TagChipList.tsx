import React from "react";
import { X } from "lucide-react";

type Tag = {
  id: number;
  name: string;
  browse_name?: string;
  TagName?: string;
  description?: string;
};

interface TagChipListProps {
  tags: Tag[];
  seriesColors: string[];
  analyticType: string;
  defaultColors: string[];
  setSeriesColors: React.Dispatch<React.SetStateAction<string[]>>;
  removeTag: (id: number) => void;
}

const TagChipList: React.FC<TagChipListProps> = React.memo(
  ({
    tags,
    seriesColors,
    analyticType,
    defaultColors,
    setSeriesColors,
    removeTag,
  }) => (
    <div
      style={{
        width: "100%",
        minHeight: 38,
        border: "1px solid #e6e6e6",
        borderRadius: 6,
        background: "#fff",
        marginBottom: 10,
        padding: 6,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "flex-start",
      }}
    >
      {tags.length === 0 && (
        <div style={{ color: "#bbb" }}>Теги не выбраны</div>
      )}
      {tags.map((tag, i) => (
        <div
          key={tag.id}
          style={{
            display: "inline-flex",
            flexDirection: "column",
            alignItems: "flex-start",
            background: "#00ffc655",
            color: "#005",
            padding: "4px 8px",
            borderRadius: 4,
            userSelect: "none",
            marginRight: 8,
            minWidth: 150,
            maxWidth: 220,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
            {analyticType === "shift_delta" ? (
              <>
                <input
                  type="color"
                  value={seriesColors[i * 2] || defaultColors[0]}
                  onChange={e =>
                    setSeriesColors(arr => {
                      const newArr = [...arr];
                      newArr[i * 2] = e.target.value;
                      return newArr;
                    })
                  }
                  style={{
                    width: 22,
                    height: 22,
                    marginRight: 2,
                    border: "none",
                    background: "none",
                  }}
                />
                <input
                  type="color"
                  value={seriesColors[i * 2 + 1] || defaultColors[1]}
                  onChange={e =>
                    setSeriesColors(arr => {
                      const newArr = [...arr];
                      newArr[i * 2 + 1] = e.target.value;
                      return newArr;
                    })
                  }
                  style={{
                    width: 22,
                    height: 22,
                    marginRight: 6,
                    border: "none",
                    background: "none",
                  }}
                />
              </>
            ) : (
              <input
                type="color"
                value={seriesColors[i] || defaultColors[i % defaultColors.length]}
                onChange={e =>
                  setSeriesColors(arr => {
                    const newArr = [...arr];
                    newArr[i] = e.target.value;
                    return newArr;
                  })
                }
                style={{
                  width: 22,
                  height: 22,
                  marginRight: 6,
                  border: "none",
                  background: "none",
                }}
              />
            )}
            <span
              style={{
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 100,
                display: "inline-block",
              }}
              title={
                tag.browse_name || tag.name || tag.TagName || "Тег"
              }
            >
              {tag.browse_name || tag.name || tag.TagName}
            </span>
            <X
              size={16}
              style={{ marginLeft: 6, cursor: "pointer" }}
              onClick={() => removeTag(tag.id)}
            />
          </div>
          {tag.description && (
            <div
              style={{
                color: "#888",
                fontSize: 12,
                marginTop: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 180,
              }}
              title={tag.description}
            >
              {tag.description}
            </div>
          )}
        </div>
      ))}
    </div>
  )
);

export default TagChipList;
