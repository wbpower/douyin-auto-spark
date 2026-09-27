import 'dotenv/config'
import { chromium, type Browser, type Cookie, type Locator, type Page } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { DouyinCookie, SameSite } from './types/douyin-cookie'
import type { Yiyan } from './types/yiyan'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const DOUYIN_ACCOUNTS_KEY = 'DOUYIN_ACCOUNTS'
const DOUYIN_ACCOUNTS_SHARD_PATTERN = /^DOUYIN_ACCOUNTS_(\d+)$/
const DOUYIN_COOKIE_KEY = 'DOUYIN_COOKIE'
const DOUYIN_TARGET_NAMES_KEY = 'DOUYIN_TARGET_NAMES'
const YIYAN_INCLUDE_SOURCE_KEY = 'YIYAN_INCLUDE_SOURCE'
const SPARK_MESSAGE_TEMPLATE_KEY = 'SPARK_MESSAGE_TEMPLATE'
const FAILURE_SCREENSHOT_DIRECTORY = 'artifacts'

const CHAT_PAGE_READY_TIMEOUT = 30000
const CHAT_PAGE_IDLE_TIMEOUT = 10000
const SEARCH_RESULT_TIMEOUT = 5000
const SEARCH_RETRY_LIMIT = 3
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_INPUT_RESET_DELAY = 500
const PAGE_STATE_POLL_INTERVAL = 500
const SEND_CONFIRM_TIMEOUT = 15000
const SEND_CONFIRM_POLL_INTERVAL = 250
const SEND_CONFIRM_STABILITY_DELAY = 3000
const EDITOR_INPUT_TIMEOUT = 3000

const LOGIN_OR_RISK_TEXT_PATTERN =
  /^(一键登录|登录|请登录|重新登录|扫码登录|手机号登录|安全验证|验证码|人机验证|验证|风险提示|风控)$/
const SEND_FAILURE_TEXT_PATTERN = /^(发送失败|消息发送失败)$/
const SEND_RETRY_BUTTON_PATTERN = /^(重新发送|重试)$/
const LOGIN_OR_RISK_SURFACE_SELECTOR =
  'form, [role="dialog"], [class*="login" i], [class*="passport" i], [class*="verify" i], [class*="captcha" i], [class*="risk" i]'

const MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const MESSAGE_TEMPLATE_PLACEHOLDERS = [
  'account',
  'friend',
  'yiyan',
  'from',
  'date',
  'time',
  'weekday',
] as const

type MessageTemplatePlaceholder = (typeof MESSAGE_TEMPLATE_PLACEHOLDERS)[number]

interface DouyinAccount {
  name: string
  cookies: Cookie[]
  targetNames: string[]
  messageTemplate: string | undefined
}

class ManualInterventionRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManualInterventionRequiredError'
  }
}

/**
 * 启动本机 Chrome 浏览器并携带 Cookie 访问抖音聊天页。
 */
async function main(): Promise<void> {
  const browserPath = resolveBrowserPath()
  const headless = resolveHeadless()
  const autoClose = resolveAutoClose()
  const includeYiyanSource = resolveYiyanIncludeSource()
  const globalMessageTemplate = resolveSparkMessageTemplate()
  const accounts = resolveDouyinAccounts(globalMessageTemplate)
  const yiyans = await resolveYiyans()
  const browser = await chromium.launch({
    headless,
    ...(browserPath ? { executablePath: browserPath } : {}),
  })
  const failures: Error[] = []

  try {
    for (const account of accounts) {
      try {
        await runDouyinAccount(browser, account, yiyans, includeYiyanSource, autoClose)
      } catch (error) {
        const accountError = toError(error)
        failures.push(
          new Error(`[${account.name}] ${accountError.message}`, { cause: accountError }),
        )
        console.error(`账号执行失败：${account.name}`, accountError)
      }
    }

    if (!autoClose) {
      const readline = createInterface({
        input,
        output,
      })

      await readline.question('所有账号已执行完成，按回车键关闭浏览器...')
      readline.close()
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} 个抖音账号执行失败`)
    }
  } finally {
    // 无论任务是否失败，都关闭浏览器以释放 Playwright 持有的进程句柄。
    await browser.close()
  }
}

/**
 * 使用独立浏览器上下文执行一个抖音账号，避免不同账号的 Cookie 相互污染。
 *
 * @param browser Playwright 浏览器实例。
 * @param account 当前执行的抖音账号配置。
 * @param yiyans 可供消息模板使用的一言列表。
 * @param includeYiyanSource 默认消息是否包含一言出处。
 * @param autoClose 执行结束后是否自动关闭浏览器上下文。
 * @returns 账号执行完成后的 Promise。
 */
async function runDouyinAccount(
  browser: Browser,
  account: DouyinAccount,
  yiyans: Yiyan[],
  includeYiyanSource: boolean,
  autoClose: boolean,
): Promise<void> {
  const context = await browser.newContext()
  let page: Page | undefined
  let currentStep = '创建浏览器上下文'

  try {
    logStep(account.name, undefined, currentStep)
    await context.addCookies(account.cookies)

    currentStep = '打开抖音聊天页'
    page = await context.newPage()
    await page.goto('https://www.douyin.com/chat', {
      waitUntil: 'domcontentloaded',
    })
    logStep(account.name, undefined, `${currentStep}完成`, `页面=${safePageLocation(page)}`)

    const searchInput = page.locator('input.semi-input[placeholder="搜索"]').first()
    currentStep = '检查登录状态和聊天页'
    await assertAuthenticatedChatPage(page, searchInput, account.name)

    currentStep = '等待会话列表加载'
    await waitForChatListReady(page, account.name)

    // 记录未命中的会话，等其余好友都发完再统一报错，避免一个人改名连累当天所有人。
    const targetFailures: Error[] = []
    const needsYiyan =
      account.messageTemplate === undefined ||
      /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)

    for (const [targetIndex, targetName] of account.targetNames.entries()) {
      currentStep = '搜索联系人'
      logStep(account.name, targetName, currentStep)

      try {
        const searchResult = await searchConversation(page, searchInput, account.name, targetName)

        if (!searchResult) {
          const error = new Error('好友不存在或搜索结果未加载，连续搜索重试仍未找到')
          console.error(`[${account.name}] 联系人处理失败：${targetName}；原因=${error.message}`)
          targetFailures.push(new Error(`[${targetName}] ${error.message}`, { cause: error }))
          await captureFailureDiagnostics(page, account, targetName, currentStep)
          continue
        }

        currentStep = '打开联系人私信'
        await assertPageDoesNotRequireIntervention(page, account.name)
        const openMessageButton = searchResult.getByText(/^(发消息|发私信)$/)
        logStep(
          account.name,
          targetName,
          currentStep,
          `搜索结果数=${await page.locator('.SearchPanelitembox').count()}；发消息控件数=${await openMessageButton.count()}`,
        )
        await openMessageButton.click({ timeout: 5000 })
        logStep(account.name, targetName, '已点击发消息控件')

        currentStep = '确认私信页和编辑框'
        const editorInput = page
          .locator(
            '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
          )
          .first()
        await editorInput.waitFor({ state: 'visible', timeout: 10000 })
        await assertPageDoesNotRequireIntervention(page, account.name)
        logStep(account.name, targetName, `${currentStep}完成`)

        let message: string

        if (account.messageTemplate !== undefined) {
          message = renderMessageTemplate(
            account.messageTemplate,
            account.name,
            targetName,
            needsYiyan ? pickRandomYiyan(yiyans) : undefined,
          )
        } else {
          const yiyan = pickRandomYiyan(yiyans)
          message = includeYiyanSource ? `${yiyan.hitokoto}\n——「${yiyan.from}」` : yiyan.hitokoto
        }

        // 排除编辑器本身和所有后代；这些节点仅用于诊断，尚未证实为消息气泡。
        const matchingMessages = page
          .getByText(message, { exact: true })
          .and(
            page.locator(
              '*:not(.messageEditorimChatEditorContainer):not(.messageEditorimChatEditorContainer *):not([data-slate-editor="true"]):not([data-slate-editor="true"] *):not([contenteditable="true"]):not([contenteditable="true"] *):not(:has(.messageEditorimChatEditorContainer, [data-slate-editor="true"], [contenteditable="true"]))',
            ),
          )
        const matchingMessageCountBeforeSend = await matchingMessages.count()

        currentStep = '输入并发送消息'
        logStep(account.name, targetName, currentStep, '开始输入消息（消息正文不写入日志）')
        await editorInput.click()
        await editorInput.focus()
        await page.keyboard.insertText(message)
        const editorContainsMessage = await waitForEditorToMatchMessage(page, editorInput, message)

        if (!editorContainsMessage) {
          throw new Error('输入确认失败：编辑框内容与待发送消息不一致，已阻止按 Enter 发送')
        }

        const beforeEnter = await logEditorSendState(
          page,
          editorInput,
          message,
          account.name,
          targetName,
          'Enter 前',
        )
        await page.keyboard.press('Enter')
        const enterPressedAt = Date.now()

        currentStep = '等待页面确认消息发送'
        for (const offset of [100, 500, 1500]) {
          await page.waitForTimeout(Math.max(0, offset - (Date.now() - enterPressedAt)))
          await logEditorSendState(
            page,
            editorInput,
            message,
            account.name,
            targetName,
            `Enter 后 ${offset}ms`,
            beforeEnter,
          )
        }
        const sendConfirmed = await waitForMessageSendConfirmation(
          page,
          editorInput,
          matchingMessages,
          matchingMessageCountBeforeSend,
          account.name,
          targetName,
        )

        if (!sendConfirmed) {
          throw new Error('发送确认失败：页面未确认消息已经成功发送')
        }

        logStep(account.name, targetName, '已确认发送消息')
      } catch (error) {
        const targetError = toError(error)
        targetFailures.push(
          new Error(`[${targetName}] ${targetError.message}`, { cause: targetError }),
        )
        console.error(
          `[${account.name}] 联系人处理失败：${targetName}；步骤=${currentStep}；原因=${targetError.message}`,
        )
        await captureFailureDiagnostics(page, account, targetName, currentStep)

        if (targetError instanceof ManualInterventionRequiredError) {
          console.error(`[${account.name}] 需要人工检查登录或安全验证；停止处理后续联系人。`)
          break
        }

        if (targetIndex < account.targetNames.length - 1) {
          try {
            currentStep = '恢复聊天页以继续下一个联系人'
            logStep(account.name, targetName, currentStep)
            await page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded' })
            await assertAuthenticatedChatPage(page, searchInput, account.name)
            await waitForChatListReady(page, account.name)
          } catch (recoveryError) {
            const errorDuringRecovery = toError(recoveryError)
            targetFailures.push(
              new Error(`页面恢复失败，无法继续后续联系人：${errorDuringRecovery.message}`, {
                cause: errorDuringRecovery,
              }),
            )
            console.error(`[${account.name}] ${errorDuringRecovery.message}`)
            await captureFailureDiagnostics(page, account, targetName, currentStep)
            break
          }
        }
      }
    }

    if (targetFailures.length > 0) {
      throw new AggregateError(targetFailures, `${targetFailures.length} 个联系人处理失败`)
    }

    logStep(account.name, undefined, '账号执行完成')
  } catch (error) {
    console.error(
      `[${account.name}] 执行中止；步骤=${currentStep}；页面=${page ? safePageLocation(page) : '尚未打开'}`,
    )
    await captureFailureDiagnostics(page, account, undefined, currentStep)
    throw error
  } finally {
    if (autoClose) {
      await context.close()
    }
  }
}

function logStep(
  accountName: string,
  targetName: string | undefined,
  step: string,
  details = '',
): void {
  const target = targetName ? `；联系人=${targetName}` : ''
  const extra = details ? `；${details}` : ''
  console.log(`[${accountName}] 步骤=${step}${target}${extra}`)
}

function safePageLocation(page: Page): string {
  try {
    const { host, pathname } = new URL(page.url())
    return `${host}${pathname}`
  } catch {
    return '<地址不可用>'
  }
}

async function assertPageDoesNotRequireIntervention(
  page: Page,
  accountName: string,
): Promise<void> {
  const abnormalState = await detectLoginOrRiskState(page)

  if (abnormalState) {
    console.error(`[${accountName}] 检测到抖音登录异常或风控状态，停止执行。`)
    throw new ManualInterventionRequiredError(
      `检测到抖音登录异常或风控状态，停止执行（${abnormalState}）`,
    )
  }
}

/**
 * 等待聊天页进入已登录状态；检测到登录页或风控提示时立即停止。
 *
 * 此函数只读取页面状态，不点击登录、验证或风控相关控件。
 */
async function assertAuthenticatedChatPage(
  page: Page,
  searchInput: Locator,
  accountName: string,
): Promise<void> {
  const deadline = Date.now() + CHAT_PAGE_READY_TIMEOUT

  while (Date.now() < deadline) {
    const searchVisible = await searchInput.isVisible().catch(() => false)
    const abnormalState = await detectLoginOrRiskState(page, searchVisible)

    if (abnormalState) {
      console.error(`[${accountName}] 检测到抖音登录异常或风控状态，停止执行。`)
      throw new ManualInterventionRequiredError(
        `检测到抖音登录异常或风控状态，停止执行（${abnormalState}）`,
      )
    }

    if (searchVisible) {
      return
    }

    await page.waitForTimeout(PAGE_STATE_POLL_INTERVAL)
  }

  const abnormalState = await detectLoginOrRiskState(page)

  if (abnormalState) {
    console.error(`[${accountName}] 检测到抖音登录异常或风控状态，停止执行。`)
    throw new ManualInterventionRequiredError(
      `检测到抖音登录异常或风控状态，停止执行（${abnormalState}）`,
    )
  }

  throw new Error('聊天页搜索框未出现，登录状态可能已失效或页面处于异常状态')
}

/**
 * 检测登录、验证或风控页面。只返回简短分类，不记录页面内容或 URL 参数。
 */
async function detectLoginOrRiskState(
  page: Page,
  searchVisible = false,
): Promise<string | undefined> {
  const currentUrl = page.url()

  try {
    const parsedUrl = new URL(currentUrl)

    if (
      parsedUrl.hostname === 'passport.douyin.com' ||
      /\/(login|passport|verify|captcha|risk)(\/|$)/i.test(parsedUrl.pathname)
    ) {
      return '页面已进入登录或安全验证流程'
    }
  } catch {
    return '页面地址异常'
  }

  const candidates = await (searchVisible ? page.locator(LOGIN_OR_RISK_SURFACE_SELECTOR) : page)
    .getByText(LOGIN_OR_RISK_TEXT_PATTERN, { exact: true })
    .all()

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      const text = (await candidate.innerText().catch(() => '')).trim()
      return text ? `页面出现“${text}”提示` : '页面出现登录或安全验证提示'
    }
  }

  return undefined
}

/**
 * 监测编辑框和非编辑器文本候选。未获得真实消息容器证据时不宣称发送成功。
 */
async function waitForMessageSendConfirmation(
  page: Page,
  editorInput: Locator,
  matchingMessages: Locator,
  matchingMessageCountBeforeSend: number,
  accountName: string,
  targetName: string,
): Promise<boolean> {
  const deadline = Date.now() + SEND_CONFIRM_TIMEOUT
  let confirmationStartedAt: number | undefined
  let lastDiagnosticAt = 0
  let unverifiedContainerLogged = false

  while (Date.now() < deadline) {
    await assertPageDoesNotRequireIntervention(page, accountName)
    const editorState = await readEditorSendState(editorInput)
    const editorIsEmpty =
      editorState !== undefined &&
      editorState.textContentLength === 0 &&
      editorState.innerTextLength === 0
    const matchingMessageCount = await matchingMessages.count().catch(() => 0)
    const newMessageIsVisible =
      matchingMessageCount > matchingMessageCountBeforeSend &&
      (await matchingMessages
        .last()
        .isVisible()
        .catch(() => false))
    const sendFailureVisible = await hasVisibleSendFailureState(page)
    const now = Date.now()

    if (now - lastDiagnosticAt >= 2000) {
      logStep(
        accountName,
        targetName,
        '检查发送状态',
        `编辑框已清空=${editorIsEmpty}；非编辑器候选节点数=${matchingMessageCount}（发送前=${matchingMessageCountBeforeSend}）；消息容器已验证=false；页面显示失败提示=${sendFailureVisible}`,
      )
      lastDiagnosticAt = now
    }

    if (editorIsEmpty && newMessageIsVisible && !sendFailureVisible) {
      confirmationStartedAt ??= now

      if (
        now - confirmationStartedAt >= SEND_CONFIRM_STABILITY_DELAY &&
        !unverifiedContainerLogged
      ) {
        logStep(
          accountName,
          targetName,
          '候选文本稳定出现，但真实消息容器尚未验证，无法确认发送成功',
        )
        unverifiedContainerLogged = true
      }
    } else {
      confirmationStartedAt = undefined
    }

    await page.waitForTimeout(SEND_CONFIRM_POLL_INTERVAL)
  }

  logStep(accountName, targetName, '发送确认超时', `等待上限=${SEND_CONFIRM_TIMEOUT}ms`)
  return false
}

interface EditorSendState {
  textContentLength: number
  innerTextLength: number
  textMatchesExpected: boolean
  focused: boolean
  visible: boolean
  contentEditable: string | null
  slateEditor: string | null
  childElementCount: number
  brCount: number
  pCount: number
  divCount: number
  lineBreakCount: number
}

async function readEditorSendState(
  editorInput: Locator,
  expectedMessage?: string,
): Promise<EditorSendState | undefined> {
  const snapshot = await editorInput
    .evaluate(
      (element: HTMLElement) => ({
        textContent: element.textContent ?? '',
        innerText: element.innerText,
        focused:
          element === element.ownerDocument.activeElement ||
          element.contains(element.ownerDocument.activeElement),
        contentEditable: element.getAttribute('contenteditable'),
        slateEditor: element.getAttribute('data-slate-editor'),
        childElementCount: element.childElementCount,
        brCount: element.querySelectorAll('br').length,
        pCount: element.querySelectorAll('p').length,
        divCount: element.querySelectorAll('div').length,
      }),
      undefined,
      { timeout: 1000 },
    )
    .catch(() => undefined)

  if (!snapshot) return undefined

  const { textContent, innerText, ...structure } = snapshot
  const normalizedTextContent = normalizeComparableText(textContent)
  const normalizedInnerText = normalizeComparableText(innerText)
  const expected =
    expectedMessage === undefined ? undefined : normalizeComparableText(expectedMessage)
  return {
    ...structure,
    visible: await editorInput.isVisible().catch(() => false),
    textContentLength: normalizedTextContent.length,
    innerTextLength: normalizedInnerText.length,
    textMatchesExpected:
      expected !== undefined &&
      (normalizedTextContent === expected || normalizedInnerText === expected),
    lineBreakCount: Math.max(
      (textContent.match(/\r\n|\r|\n/g) ?? []).length,
      (innerText.match(/\r\n|\r|\n/g) ?? []).length,
    ),
  }
}

async function logEditorSendState(
  page: Page,
  editorInput: Locator,
  message: string,
  accountName: string,
  targetName: string,
  phase: string,
  beforeEnter?: EditorSendState,
): Promise<EditorSendState | undefined> {
  const abnormalState = await detectLoginOrRiskState(page)
  if (abnormalState) {
    logStep(
      accountName,
      targetName,
      phase,
      JSON.stringify({
        page: safePageLocation(page),
        interventionRequired: true,
      }),
    )
    throw new ManualInterventionRequiredError(
      `检测到抖音登录异常或风控状态，停止执行（${abnormalState}）`,
    )
  }
  const state = await readEditorSendState(editorInput, message)
  const sendFailureVisible = await hasVisibleSendFailureState(page)
  logStep(
    accountName,
    targetName,
    phase,
    JSON.stringify({
      page: safePageLocation(page),
      interventionRequired: abnormalState !== undefined,
      sendFailureVisible,
      editorReadable: state !== undefined,
      ...state,
    }),
  )

  if (
    beforeEnter &&
    state?.textMatchesExpected &&
    (state.childElementCount > beforeEnter.childElementCount ||
      state.brCount > beforeEnter.brCount ||
      state.pCount > beforeEnter.pCount ||
      state.divCount > beforeEnter.divCount ||
      state.lineBreakCount > beforeEnter.lineBreakCount)
  ) {
    logStep(accountName, targetName, '疑似 Enter 被编辑器解释为换行，而非发送')
  }

  return state
}

async function waitForEditorToMatchMessage(
  page: Page,
  editorInput: Locator,
  message: string,
): Promise<boolean> {
  const deadline = Date.now() + EDITOR_INPUT_TIMEOUT
  const expectedText = normalizeComparableText(message)
  let inputDiagnostics: Record<string, number | boolean | string | null> = {
    expectedLength: expectedText.length,
    editorReadable: false,
  }

  while (Date.now() < deadline) {
    const editorState = await editorInput
      .evaluate((element: HTMLElement) => ({
        textContent: element.textContent ?? '',
        innerText: element.innerText,
        focused:
          element === element.ownerDocument.activeElement ||
          element.contains(element.ownerDocument.activeElement),
        slateEditor: element.getAttribute('data-slate-editor'),
        contentEditable: element.getAttribute('contenteditable'),
      }))
      .catch(() => undefined)

    if (editorState) {
      const normalizedTextContent = normalizeComparableText(editorState.textContent)
      const normalizedInnerText = normalizeComparableText(editorState.innerText)

      if (normalizedTextContent === expectedText || normalizedInnerText === expectedText) {
        return true
      }

      inputDiagnostics = {
        expectedLength: expectedText.length,
        textContentLength: normalizedTextContent.length,
        innerTextLength: normalizedInnerText.length,
        focused: editorState.focused,
        slateEditor: editorState.slateEditor,
        contentEditable: editorState.contentEditable,
        editorReadable: true,
      }
    } else {
      inputDiagnostics.editorReadable = false
    }

    await page.waitForTimeout(100)
  }

  console.warn(`输入确认超时（仅长度和编辑器状态）：${JSON.stringify(inputDiagnostics)}`)
  return false
}

function normalizeComparableText(value: string): string {
  return value
    .replace(/(?:\u200B|\u200C|\u200D|\u2060|\uFEFF)/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

async function hasVisibleText(page: Page, pattern: RegExp): Promise<boolean> {
  const candidates = await page.getByText(pattern, { exact: true }).all()

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return true
    }
  }

  return false
}

async function hasVisibleSendFailureState(page: Page): Promise<boolean> {
  if (await hasVisibleText(page, SEND_FAILURE_TEXT_PATTERN)) {
    return true
  }

  const retryButtons = await page
    .getByRole('button', { name: SEND_RETRY_BUTTON_PATTERN, exact: true })
    .all()

  for (const retryButton of retryButtons) {
    if (await retryButton.isVisible().catch(() => false)) {
      return true
    }
  }

  return false
}

/**
 * 等待会话列表真正渲染出数据再开始搜索。
 *
 * 搜索框会先于会话列表渲染，若此时就输入关键词，抖音的搜索索引尚未就绪，
 * 结果面板会一直为空，导致好友被误判成「改名了」。
 *
 * @param page 当前账号的聊天页。
 * @param accountName 账号名称，仅用于日志。
 * @returns 等待结束后的 Promise，超时也不抛错，交给后续搜索重试兜底。
 */
async function waitForChatListReady(page: Page, accountName: string): Promise<void> {
  const conversationList = page.locator('[class*="conversation"], [class*="Conversation"]')
  let conversationListReady = true

  try {
    await conversationList.first().waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
  } catch (error) {
    conversationListReady = false
    console.warn(
      `[${accountName}] 会话列表等待超时：${toError(error).message}；匹配节点数=${await conversationList.count()}`,
    )
  }

  if (!conversationListReady) {
    console.log(`[${accountName}] 会话列表未在预期时间内出现，将依赖搜索重试兜底`)
  }

  // 会话列表的头像与最近消息还会继续拉取，等网络安静下来搜索命中率更高。
  try {
    await page.waitForLoadState('networkidle', { timeout: CHAT_PAGE_IDLE_TIMEOUT })
  } catch (error) {
    console.warn(
      `[${accountName}] 页面在 ${CHAT_PAGE_IDLE_TIMEOUT}ms 内未达到 networkidle，继续使用 DOM 状态检查：${toError(error).message}`,
    )
  }
}

/**
 * 带重试地搜索会话，避免把「数据还没加载好」误判成「好友改了昵称」。
 *
 * 每一轮都重新清空输入框并等待旧结果消失，防止上一个好友的残留结果被当成命中。
 *
 * @param page 当前账号的聊天页。
 * @param searchInput 聊天页左侧的搜索输入框。
 * @param accountName 账号名称，仅用于日志。
 * @param targetName 需要搜索的好友昵称或备注名。
 * @returns 命中的搜索结果项，全部重试都没命中时返回 undefined。
 */
async function searchConversation(
  page: Page,
  searchInput: Locator,
  accountName: string,
  targetName: string,
): Promise<Locator | undefined> {
  const searchResult = page
    .locator('.SearchPanelitembox')
    .filter({
      has: page.getByText(targetName, { exact: true }),
    })
    .first()

  for (let attempt = 1; attempt <= SEARCH_RETRY_LIMIT; attempt += 1) {
    await searchInput.fill('')
    // 等旧的结果面板收起，否则会读到上一个好友残留的列表项。
    try {
      await page
        .locator('.SearchPanelitembox')
        .first()
        .waitFor({ state: 'hidden', timeout: SEARCH_RESULT_TIMEOUT })
    } catch (error) {
      console.warn(
        `[${accountName}] 第 ${attempt} 次搜索时旧结果面板未按时收起：${toError(error).message}`,
      )
    }
    await page.waitForTimeout(SEARCH_INPUT_RESET_DELAY)
    await searchInput.fill(targetName)

    let searchResultVisible = true

    try {
      await searchResult.waitFor({ state: 'visible', timeout: SEARCH_RESULT_TIMEOUT })
    } catch (error) {
      searchResultVisible = false
      console.warn(
        `[${accountName}] 第 ${attempt}/${SEARCH_RETRY_LIMIT} 次搜索未命中联系人“${targetName}”：${toError(error).message}；结果容器数=${await page.locator('.SearchPanelitembox').count()}`,
      )
    }

    if (searchResultVisible) {
      return searchResult
    }

    if (attempt < SEARCH_RETRY_LIMIT) {
      console.log(
        `[${accountName}] 第 ${attempt} 次搜索未命中，${SEARCH_RETRY_INTERVAL} 毫秒后重试：${targetName}`,
      )
      await page.waitForTimeout(SEARCH_RETRY_INTERVAL)
    }
  }

  return undefined
}

/**
 * 在页面仍可访问时保存失败现场，且不让截图错误覆盖原始任务异常。
 */
async function captureFailureScreenshot(
  page: Page | undefined,
  accountName: string,
): Promise<void> {
  if (!page || page.isClosed()) {
    return
  }

  try {
    await mkdir(FAILURE_SCREENSHOT_DIRECTORY, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const screenshotPath = `${FAILURE_SCREENSHOT_DIRECTORY}/failure-screenshot-${toSafeFileName(accountName)}-${timestamp}.png`
    await page.screenshot({
      path: screenshotPath,
      // 仅保存当前视口，避免把完整聊天历史写入诊断截图。
      fullPage: false,
    })
    console.log(`已保存失败截图：${screenshotPath}`)
  } catch (error) {
    console.error('保存失败截图失败:', error)
  }
}

async function captureFailureDiagnostics(
  page: Page | undefined,
  account: DouyinAccount,
  targetName: string | undefined,
  step: string,
): Promise<void> {
  if (!page || page.isClosed()) {
    return
  }

  const label = `${account.name}-${targetName ?? 'account'}-${step}`
  await captureFailureScreenshot(page, label)

  try {
    const summary = await page.evaluate(() => {
      const selector =
        'button, [role="button"], [role="alert"], [role="dialog"], input, textarea, [contenteditable="true"]'
      const visibleControls = Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          )
        })
        .slice(0, 80)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          id: element.id || undefined,
          className:
            typeof element.className === 'string' ? element.className.slice(0, 160) : undefined,
          ariaLabel: element.getAttribute('aria-label'),
          placeholder: element.getAttribute('placeholder'),
          title: element.getAttribute('title'),
          inputType: element.getAttribute('type'),
          disabled:
            'disabled' in element ? Boolean((element as HTMLInputElement).disabled) : undefined,
        }))

      return {
        page: `${window.location.host}${window.location.pathname}`,
        readyState: document.readyState,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        counts: {
          searchInput: document.querySelectorAll('input.semi-input[placeholder="搜索"]').length,
          searchResult: document.querySelectorAll('.SearchPanelitembox').length,
          messageEditor: document.querySelectorAll(
            '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
          ).length,
        },
        visibleControls,
      }
    })

    const redactedSummary = redactDiagnosticSummary(summary, [account.name, ...account.targetNames])
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dumpPath = `${FAILURE_SCREENSHOT_DIRECTORY}/failure-ui-${toSafeFileName(label)}-${timestamp}.json`
    const serializedSummary = JSON.stringify(redactedSummary)

    await writeFile(dumpPath, `${JSON.stringify(redactedSummary, null, 2)}\n`, 'utf8')
    console.error(
      `[${account.name}] 失败页面结构摘要（不含输入框值、消息正文或 Cookie）：${serializedSummary}`,
    )
    console.error(`[${account.name}] 已保存页面结构摘要：${dumpPath}`)
  } catch (error) {
    console.error(`[${account.name}] 页面结构摘要采集失败：${toError(error).message}`)
  }
}

function redactDiagnosticSummary<T>(value: T, namesToRedact: string[]): T {
  if (typeof value === 'string') {
    return namesToRedact.reduce(
      (text, name) => (name ? text.split(name).join('<联系人>') : text),
      value,
    ) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticSummary(item, namesToRedact)) as T
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        redactDiagnosticSummary(child, namesToRedact),
      ]),
    ) as T
  }

  return value
}

function toSafeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 解析 Playwright 可选的浏览器启动路径。
 */
function resolveBrowserPath(): string | undefined {
  const browserPathFromEnv = process.env.PLAYWRIGHT_BROWSER_PATH?.trim()

  if (browserPathFromEnv) {
    return browserPathFromEnv
  }

  return undefined
}

/**
 * 解析 Playwright 是否使用无头模式。
 */
function resolveHeadless(): boolean {
  const headless = process.env.PLAYWRIGHT_HEADLESS?.trim().toLowerCase()

  if (!headless) {
    return true
  }

  if (headless === 'true') {
    return true
  }

  if (headless === 'false') {
    return false
  }

  throw new Error('PLAYWRIGHT_HEADLESS 只能配置为 true 或 false')
}

/**
 * 解析脚本结束后是否自动关闭浏览器。
 */
function resolveAutoClose(): boolean {
  const autoClose = process.env.AUTO_CLOSE?.trim().toLowerCase()

  if (!autoClose) {
    return true
  }

  if (autoClose === 'true') {
    return true
  }

  if (autoClose === 'false') {
    return false
  }

  throw new Error('AUTO_CLOSE 只能配置为 true 或 false')
}

/**
 * 解析发送一言时是否携带出处。
 */
function resolveYiyanIncludeSource(): boolean {
  const includeSource = process.env[YIYAN_INCLUDE_SOURCE_KEY]?.trim().toLowerCase()

  if (!includeSource || includeSource === 'true') {
    return true
  }

  if (includeSource === 'false') {
    return false
  }

  throw new Error(`${YIYAN_INCLUDE_SOURCE_KEY} 只能配置为 true 或 false`)
}

/**
 * 解析自定义火花消息模板，未配置时返回 undefined 以沿用默认的一言格式。
 */
function resolveSparkMessageTemplate(): string | undefined {
  const template = process.env[SPARK_MESSAGE_TEMPLATE_KEY]?.trim()

  if (!template) {
    return undefined
  }

  return normalizeMessageTemplate(template, SPARK_MESSAGE_TEMPLATE_KEY)
}

/**
 * 校验并标准化消息模板。
 */
function normalizeMessageTemplate(template: string, sourceName: string): string {
  // 启动时就校验占位符，避免把写错的 {{xxx}} 原样发给好友。
  const unknownPlaceholders = [
    ...new Set(
      [...template.matchAll(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN)]
        .map((match) => match[1])
        .filter(
          (name) => !MESSAGE_TEMPLATE_PLACEHOLDERS.includes(name as MessageTemplatePlaceholder),
        ),
    ),
  ]

  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `${sourceName} 中存在未识别的占位符：${unknownPlaceholders
        .map((name) => `{{${name}}}`)
        .join(
          '、',
        )}。支持的占位符：${MESSAGE_TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(' ')}`,
    )
  }

  // .env 中难以书写多行值，因此支持用字面 \n 表示换行。
  return template.replace(/\\n/g, '\n')
}

/**
 * 将消息模板渲染为实际发送的文本。
 */
function renderMessageTemplate(
  template: string,
  account: string,
  friend: string,
  yiyan: Yiyan | undefined,
): string {
  // 定时任务跑在 UTC 时区的 runner 上，日期占位符统一按上海时区计算。
  const now = dayjs().tz('Asia/Shanghai')
  const placeholderValues: Record<MessageTemplatePlaceholder, string> = {
    account,
    friend,
    yiyan: yiyan?.hitokoto ?? '',
    from: yiyan?.from ?? '',
    date: now.format('YYYY-MM-DD'),
    time: now.format('HH:mm'),
    weekday: now.format('dddd'),
  }

  return template.replace(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN, (_match, name: string) => {
    return placeholderValues[name as MessageTemplatePlaceholder] ?? ''
  })
}

/**
 * 解析多账号配置。支持历史变量 DOUYIN_ACCOUNTS 与按编号拆分的 DOUYIN_ACCOUNTS_N，
 * 所有存在的配置会按历史变量、分片编号升序合并；没有多账号配置时回退到单账号变量。
 */
function resolveDouyinAccounts(globalMessageTemplate: string | undefined): DouyinAccount[] {
  const accountSources = resolveDouyinAccountSources()

  if (accountSources.length === 0) {
    return [
      {
        name: '默认账号',
        cookies: resolveLegacyDouyinCookies(),
        targetNames: resolveLegacyDouyinTargetNames(),
        messageTemplate: globalMessageTemplate,
      },
    ]
  }

  const accountNames = new Set<string>()

  return accountSources.flatMap(({ sourceName, text }) => {
    const accountsValue = parseJson(text, sourceName)

    if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
      throw new Error(`${sourceName} 必须是非空账号数组 JSON`)
    }

    return accountsValue.map((value, index) => {
      const accountSourceName = `${sourceName}[${index}]`

      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${accountSourceName} 必须是账号对象`)
      }

      const accountValue = value as Record<string, unknown>
      const name = resolveAccountName(accountValue.name, accountSourceName)

      if (accountNames.has(name)) {
        throw new Error(`多账号配置中存在重复账号名称：${name}`)
      }
      accountNames.add(name)

      return {
        name,
        cookies: resolveCookieArray(accountValue.cookie, `${accountSourceName}.cookie`),
        targetNames: resolveTargetNameArray(
          accountValue.targetNames,
          `${accountSourceName}.targetNames`,
        ),
        messageTemplate: resolveAccountMessageTemplate(
          accountValue.messageTemplate,
          `${accountSourceName}.messageTemplate`,
          globalMessageTemplate,
        ),
      }
    })
  })
}

function resolveDouyinAccountSources(): Array<{ sourceName: string; text: string }> {
  const sources: Array<{ sourceName: string; text: string }> = []
  const legacyText = process.env[DOUYIN_ACCOUNTS_KEY]?.trim()

  if (legacyText) {
    sources.push({ sourceName: DOUYIN_ACCOUNTS_KEY, text: legacyText })
  }

  const shardSources: Array<{ index: number; sourceName: string; text: string }> = []

  for (const [sourceName, value] of Object.entries(process.env)) {
    const match = sourceName.match(DOUYIN_ACCOUNTS_SHARD_PATTERN)
    const text = value?.trim()

    if (!match || !text) {
      continue
    }

    shardSources.push({
      index: Number(match[1]),
      sourceName,
      text,
    })
  }

  shardSources.sort((left, right) => left.index - right.index)
  sources.push(...shardSources.map(({ sourceName, text }) => ({ sourceName, text })))

  return sources
}

function resolveAccountName(value: unknown, sourceName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${sourceName}.name 必须是非空字符串`)
  }

  return value.trim()
}

function resolveAccountMessageTemplate(
  value: unknown,
  sourceName: string,
  globalMessageTemplate: string | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    return globalMessageTemplate
  }

  if (typeof value !== 'string') {
    throw new Error(`${sourceName} 必须是字符串`)
  }

  const template = value.trim()
  return template ? normalizeMessageTemplate(template, sourceName) : globalMessageTemplate
}

/**
 * 解析单账号 Cookie 配置。
 */
function resolveLegacyDouyinCookies(): Cookie[] {
  const douyinCookieText = process.env[DOUYIN_COOKIE_KEY]?.trim()

  if (!douyinCookieText) {
    throw new Error(
      `请设置 ${DOUYIN_COOKIE_KEY} 和 ${DOUYIN_TARGET_NAMES_KEY}；多账号请使用 ${DOUYIN_ACCOUNTS_KEY}_1 等分片变量`,
    )
  }

  return resolveCookieArray(parseJson(douyinCookieText, DOUYIN_COOKIE_KEY), DOUYIN_COOKIE_KEY)
}

/**
 * 解析单账号会话名称配置。
 */
function resolveLegacyDouyinTargetNames(): string[] {
  const targetNamesText = process.env[DOUYIN_TARGET_NAMES_KEY]?.trim()

  if (!targetNamesText) {
    throw new Error(
      `请设置环境变量 ${DOUYIN_TARGET_NAMES_KEY}，或在 .env 中配置 ${DOUYIN_TARGET_NAMES_KEY}`,
    )
  }

  return resolveTargetNameArray(
    parseJson(targetNamesText, DOUYIN_TARGET_NAMES_KEY),
    DOUYIN_TARGET_NAMES_KEY,
  )
}

function resolveCookieArray(value: unknown, sourceName: string): Cookie[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${sourceName} 必须是非空 Cookie 数组`)
  }

  return (value as DouyinCookie[]).map(toPlaywrightCookie)
}

function resolveTargetNameArray(value: unknown, sourceName: string): string[] {
  const targetNames = value as unknown[]

  if (
    !Array.isArray(targetNames) ||
    targetNames.length === 0 ||
    targetNames.some((targetName) => typeof targetName !== 'string' || !targetName.trim())
  ) {
    throw new Error(`${sourceName} 必须是非空字符串数组`)
  }

  return targetNames.map((targetName) => (targetName as string).trim())
}

function parseJson(value: string, sourceName: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`${sourceName} 不是有效的 JSON`, { cause: error })
  }
}

/**
 * 解析一言数据列表。
 */
async function resolveYiyans(): Promise<Yiyan[]> {
  const yiyanText = await readFile('assets/yiyan.json', 'utf8')
  const yiyans = JSON.parse(yiyanText) as Yiyan[]

  if (!Array.isArray(yiyans) || yiyans.length === 0) {
    throw new Error('assets/yiyan.json 必须是非空数组')
  }

  return yiyans
}

/**
 * 从一言数据中随机挑选一条。
 */
function pickRandomYiyan(yiyans: Yiyan[]): Yiyan {
  return yiyans[Math.floor(Math.random() * yiyans.length)]
}

/**
 * 将抖音 Cookie 数据转换为 Playwright Cookie 数据。
 */
function toPlaywrightCookie(cookie: DouyinCookie): Cookie {
  const playwrightCookie: Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: toPlaywrightSameSite(cookie.sameSite),
  }

  return playwrightCookie
}

/**
 * 将抖音 Cookie 的 SameSite 值转换为 Playwright Cookie 值。
 */
function toPlaywrightSameSite(sameSite: SameSite | null): Cookie['sameSite'] {
  if (sameSite === 'no_restriction') {
    return 'None'
  }

  return 'Lax'
}

main().catch((error: unknown) => {
  console.error('启动 Chrome 访问抖音聊天页失败:', error)
  process.exitCode = 1
})
