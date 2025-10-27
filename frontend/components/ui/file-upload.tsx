"use client";

import React, { useCallback, useRef, useState } from "react";

type FileUploadProps = {
  onChange?: (files: File[]) => void;
  multiple?: boolean;
  accept?: string;
};

export function FileUpload({ onChange, multiple = true, accept }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const triggerInput = () => inputRef.current?.click();

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      const files = Array.from(list);
      onChange?.(files);
    },
    [onChange]
  );

  return (
    <div
      className={[
        "w-full h-64 flex items-center justify-center",
        "border border-dashed rounded-lg transition-colors",
        isDragging ? "border-black dark:border-white" : "border-gray-300 dark:border-gray-700",
        "bg-white dark:bg-black",
      ].join(" ")}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
      onClick={triggerInput}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") triggerInput();
      }}
    >
      <div className="text-center select-none">
        <p className="font-medium">Drop files here</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">or click to browse</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple={multiple}
        accept={accept}
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}

