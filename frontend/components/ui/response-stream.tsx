"use client"

import { cn } from "@/lib/utils"
import React, { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

export type Mode = "typewriter" | "fade"

export type UseTextStreamOptions = {
  textStream: string | AsyncIterable<string>
  speed?: number
  mode?: Mode
  onComplete?: () => void
  fadeDuration?: number
  segmentDelay?: number
  characterChunkSize?: number
  onError?: (error: unknown) => void
}

export type UseTextStreamResult = {
  displayedText: string
  isComplete: boolean
  segments: { text: string; index: number }[]
  getFadeDuration: () => number
  getSegmentDelay: () => number
  reset: () => void
  startStreaming: () => void
  pause: () => void
  resume: () => void
}

function useTextStream({
  textStream,
  speed = 20,
  mode = "typewriter",
  onComplete,
  fadeDuration,
  segmentDelay,
  characterChunkSize,
  onError,
}: UseTextStreamOptions): UseTextStreamResult {
  const [displayedText, setDisplayedText] = useState("")
  const [isComplete, setIsComplete] = useState(false)
  const [segments, setSegments] = useState<{ text: string; index: number }[]>(
    []
  )

  const speedRef = useRef(speed)
  const modeRef = useRef(mode)
  const currentIndexRef = useRef(0)
  const animationRef = useRef<number | null>(null)
  const fadeDurationRef = useRef(fadeDuration)
  const segmentDelayRef = useRef(segmentDelay)
  const characterChunkSizeRef = useRef(characterChunkSize)
  const streamRef = useRef<AbortController | null>(null)
  const completedRef = useRef(false)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => {
    speedRef.current = speed
    modeRef.current = mode
    fadeDurationRef.current = fadeDuration
    segmentDelayRef.current = segmentDelay
    characterChunkSizeRef.current = characterChunkSize
  }, [speed, mode, fadeDuration, segmentDelay, characterChunkSize])

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  const getChunkSize = useCallback(() => {
    if (typeof characterChunkSizeRef.current === "number") {
      return Math.max(1, characterChunkSizeRef.current)
    }

    const normalizedSpeed = Math.min(100, Math.max(1, speedRef.current))

    if (modeRef.current === "typewriter") {
      if (normalizedSpeed < 25) return 1
      return Math.max(1, Math.round((normalizedSpeed - 25) / 10))
    } else if (modeRef.current === "fade") {
      return 1
    }

    return 1
  }, [])

  const getProcessingDelay = useCallback(() => {
    if (typeof segmentDelayRef.current === "number") {
      return Math.max(0, segmentDelayRef.current)
    }

    const normalizedSpeed = Math.min(100, Math.max(1, speedRef.current))
    return Math.max(1, Math.round(100 / Math.sqrt(normalizedSpeed)))
  }, [])

  const getFadeDuration = useCallback(() => {
    if (typeof fadeDurationRef.current === "number")
      return Math.max(10, fadeDurationRef.current)

    const normalizedSpeed = Math.min(100, Math.max(1, speedRef.current))
    return Math.round(1000 / Math.sqrt(normalizedSpeed))
  }, [])

  const getSegmentDelay = useCallback(() => {
    if (typeof segmentDelayRef.current === "number")
      return Math.max(0, segmentDelayRef.current)

    const normalizedSpeed = Math.min(100, Math.max(1, speedRef.current))
    return Math.max(1, Math.round(100 / Math.sqrt(normalizedSpeed)))
  }, [])

  const updateSegments = useCallback((text: string) => {
    if (modeRef.current === "fade") {
      try {
        const segmenter = new Intl.Segmenter(navigator.language, {
          granularity: "word",
        })
        const segmentIterator = segmenter.segment(text)
        const newSegments = Array.from(segmentIterator).map(
          (segment, index) => ({
            text: segment.segment,
            index,
          })
        )
        setSegments(newSegments)
      } catch (error) {
        const newSegments = text
          .split(/(\s+)/)
          .filter(Boolean)
          .map((word, index) => ({
            text: word,
            index,
          }))
        setSegments(newSegments)
        onError?.(error)
      }
    }
  }, [onError])

  const markComplete = useCallback(() => {
    if (!completedRef.current) {
      completedRef.current = true
      setIsComplete(true)
      onCompleteRef.current?.()
    }
  }, [])

  const reset = useCallback(() => {
    currentIndexRef.current = 0
    setDisplayedText("")
    setSegments([])
    setIsComplete(false)
    completedRef.current = false

    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
  }, [])

  const processStringTypewriter = useCallback(
    (text: string) => {
      let lastFrameTime = 0

      const streamContent = (timestamp: number) => {
        const delay = getProcessingDelay()
        if (delay > 0 && timestamp - lastFrameTime < delay) {
          animationRef.current = requestAnimationFrame(streamContent)
          return
        }
        lastFrameTime = timestamp

        if (currentIndexRef.current >= text.length) {
          markComplete()
          return
        }

        const chunkSize = getChunkSize()
        const endIndex = Math.min(
          currentIndexRef.current + chunkSize,
          text.length
        )
        const newDisplayedText = text.slice(0, endIndex)

        setDisplayedText(newDisplayedText)
        if (modeRef.current === "fade") {
          updateSegments(newDisplayedText)
        }

        currentIndexRef.current = endIndex

        if (endIndex < text.length) {
          animationRef.current = requestAnimationFrame(streamContent)
        } else {
          markComplete()
        }
      }

      animationRef.current = requestAnimationFrame(streamContent)
    },
    [getProcessingDelay, getChunkSize, updateSegments, markComplete]
  )

  const processAsyncIterable = useCallback(
    async (stream: AsyncIterable<string>) => {
      const controller = new AbortController()
      streamRef.current = controller

      let displayed = ""

      try {
        for await (const chunk of stream) {
          if (controller.signal.aborted) return

          displayed += chunk
          setDisplayedText(displayed)
          updateSegments(displayed)
        }

        markComplete()
      } catch (error) {
        console.error("Error processing text stream:", error)
        markComplete()
        onError?.(error)
      }
    },
    [updateSegments, markComplete, onError]
  )

  const startStreaming = useCallback(() => {
    reset()

    if (typeof textStream === "string") {
      processStringTypewriter(textStream)
    } else if (textStream) {
      processAsyncIterable(textStream)
    }
  }, [textStream, reset, processStringTypewriter, processAsyncIterable])

  const pause = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
  }, [])

  const resume = useCallback(() => {
    if (typeof textStream === "string" && !isComplete) {
      processStringTypewriter(textStream)
    }
  }, [textStream, isComplete, processStringTypewriter])

  useEffect(() => {
    startStreaming()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
      if (streamRef.current) {
        streamRef.current.abort()
      }
    }
  }, [textStream, startStreaming])

  return {
    displayedText,
    isComplete,
    segments,
    getFadeDuration,
    getSegmentDelay,
    reset,
    startStreaming,
    pause,
    resume,
  }
}

export type ResponseStreamProps = {
  textStream: string | AsyncIterable<string>
  mode?: Mode
  speed?: number // 1-100, where 1 is slowest and 100 is fastest
  className?: string
  onComplete?: () => void
  as?: keyof React.JSX.IntrinsicElements // Element type to render
  fadeDuration?: number // Custom fade duration in ms (overrides speed)
  segmentDelay?: number // Custom delay between segments in ms (overrides speed)
  characterChunkSize?: number // Custom characters per frame for typewriter mode (overrides speed)
  markdown?: boolean // Enable markdown rendering
}

function ResponseStream({
  textStream,
  mode = "typewriter",
  speed = 20,
  className = "",
  onComplete,
  as = "div",
  fadeDuration,
  segmentDelay,
  characterChunkSize,
  markdown = false,
}: ResponseStreamProps) {
  const animationEndRef = useRef<(() => void) | null>(null)

  const {
    displayedText,
    isComplete,
    segments,
    getFadeDuration,
    getSegmentDelay,
  } = useTextStream({
    textStream,
    speed,
    mode,
    onComplete,
    fadeDuration,
    segmentDelay,
    characterChunkSize,
  })

  useEffect(() => {
    animationEndRef.current = onComplete ?? null
  }, [onComplete])

  const handleLastSegmentAnimationEnd = useCallback(() => {
    if (animationEndRef.current && isComplete) {
      animationEndRef.current()
    }
  }, [isComplete])

  // fadeStyle is the style for the fade animation
  const fadeStyle = `
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    .fade-segment {
      display: inline-block;
      opacity: 0;
      animation: fadeIn ${getFadeDuration()}ms ease-out forwards;
    }

    .fade-segment-space {
      white-space: pre;
    }
  `

  const renderContent = () => {
    // Helper to wrap content in markdown if enabled
    const wrapInMarkdown = (content: React.ReactNode) => {
      if (!markdown || typeof content !== 'string') return content;
      return (
        <div className="prose prose-sm max-w-none prose-headings:font-bold prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="my-2 text-black dark:text-white">{children}</p>,
              h1: ({ children }) => <h1 className="text-2xl font-bold my-3 text-black dark:text-white">{children}</h1>,
              h2: ({ children }) => <h2 className="text-xl font-bold my-3 text-black dark:text-white">{children}</h2>,
              h3: ({ children }) => <h3 className="text-lg font-bold my-2 text-black dark:text-white">{children}</h3>,
              ul: ({ children }) => <ul className="list-disc pl-6 my-2 text-black dark:text-white">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-6 my-2 text-black dark:text-white">{children}</ol>,
              li: ({ children }) => <li className="my-1 text-black dark:text-white">{children}</li>,
              strong: ({ children }) => <strong className="font-bold text-black dark:text-white">{children}</strong>,
              em: ({ children }) => <em className="italic text-black dark:text-white">{children}</em>,
              code: ({ children, className }) => {
                const isInline = !className;
                if (isInline) {
                  return <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-sm font-mono text-black dark:text-white">{children}</code>;
                }
                return <code className={`${className} text-black dark:text-white`}>{children}</code>;
              },
              pre: ({ children }) => <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto my-3">{children}</pre>,
            }}
          >
            {content as string}
          </ReactMarkdown>
        </div>
      );
    };

    switch (mode) {
      case "typewriter":
        return wrapInMarkdown(displayedText);

      case "fade":
        if (markdown) {
          // For fade mode with markdown, render the whole text with markdown
          return (
            <>
              <style>{fadeStyle}</style>
              <div className="relative fade-segment" style={{ animationDelay: '0ms' }}>
                {wrapInMarkdown(displayedText)}
              </div>
            </>
          );
        }
        return (
          <>
            <style>{fadeStyle}</style>
            <div className="relative">
              {segments.map((segment, idx) => {
                const isWhitespace = /^\s+$/.test(segment.text)
                const isLastSegment = idx === segments.length - 1

                return (
                  <span
                    key={`${segment.text}-${idx}`}
                    className={cn(
                      "fade-segment",
                      isWhitespace && "fade-segment-space"
                    )}
                    style={{
                      animationDelay: `${idx * getSegmentDelay()}ms`,
                    }}
                    onAnimationEnd={
                      isLastSegment ? handleLastSegmentAnimationEnd : undefined
                    }
                  >
                    {segment.text}
                  </span>
                )
              })}
            </div>
          </>
        )

      default:
        return wrapInMarkdown(displayedText);
    }
  }

  const Container = as as keyof React.JSX.IntrinsicElements

  return <Container className={className}>{renderContent()}</Container>
}

export { useTextStream, ResponseStream }

