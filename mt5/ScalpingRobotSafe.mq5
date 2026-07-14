//+------------------------------------------------------------------+
//|                                          ScalpingRobotSafe.mq5    |
//|   Safe automated gold (XAUUSD) trading Expert Advisor for MT5     |
//|                                                                  |
//|   - Trades XAUUSD only (gold)                                     |
//|   - No martingale / no grid  -> every trade has a Stop Loss       |
//|   - Hard capital protection: stops if account drops X% (def 20%)  |
//|   - Daily loss limit, spread filter, session filter, news filter  |
//|   - Auto lot sizing by risk %, ATR-based SL/TP, trailing stop     |
//|                                                                  |
//|   Educational tool. No profit is guaranteed. Test on a DEMO       |
//|   account first and understand the risks before using real money. |
//+------------------------------------------------------------------+
#property copyright "ScalpingRobotSafe"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>
#include <Trade/PositionInfo.mqh>

CTrade         trade;
CPositionInfo  posinfo;

//==================================================================
//  INPUTS
//==================================================================
input group "=== General / ทั่วไป ==="
input ENUM_TIMEFRAMES InpTimeframe      = PERIOD_M5;   // Timeframe (แนะนำ M5)
input long            InpMagic          = 20260714;    // Magic number (รหัสบอต)
input int             InpMaxSpreadPoints= 50;          // Max spread (points) - ข้าม spread กว้าง

input group "=== Risk / ความเสี่ยง (สายปลอดภัย) ==="
input double InpRiskPerTradePct = 0.5;   // เสี่ยงต่อไม้ (% ของเงินทุน)
input double InpMaxAccountDDPct = 20.0;  // หยุดถาวรเมื่อพอร์ตลดถึง (% ของเงินต้น)
input double InpMaxDailyLossPct = 5.0;   // หยุดพักเมื่อขาดทุนต่อวันถึง (%)
input int    InpMaxOpenPositions= 1;     // จำนวนออเดอร์เปิดพร้อมกันสูงสุด
input double InpFixedLot         = 0.0;  // ถ้า > 0 จะใช้ lot คงที่นี้แทนการคำนวณ

input group "=== SL / TP (ATR based) ==="
input int    InpATRPeriod    = 14;   // ATR period
input double InpSL_ATR       = 1.5;  // Stop Loss = ATR x นี้
input double InpTP_ATR       = 2.0;  // Take Profit = ATR x นี้
input bool   InpUseTrailing  = true; // เปิด Trailing stop
input double InpTrailStartATR= 1.0;  // เริ่ม trail เมื่อกำไรถึง ATR x นี้
input double InpTrailATR      = 1.0; // ระยะ trail = ATR x นี้

input group "=== Strategy / กลยุทธ์ ==="
input int    InpEMAfast   = 8;    // EMA เร็ว
input int    InpEMAslow   = 21;   // EMA ช้า
input int    InpEMAtrend  = 200;  // EMA เทรนด์ใหญ่ (กรองทิศทาง)
input int    InpRSIPeriod = 14;   // RSI period
input double InpRSIbuyMax = 70.0; // ซื้อได้เมื่อ RSI ต่ำกว่านี้
input double InpRSIsellMin= 30.0; // ขายได้เมื่อ RSI สูงกว่านี้

input group "=== Session filter (server time) ==="
input bool   InpUseSession      = true; // เทรดเฉพาะช่วงเวลา
input int    InpSessionStartHour= 8;    // ชั่วโมงเริ่ม (เวลาเซิร์ฟเวอร์)
input int    InpSessionEndHour  = 22;   // ชั่วโมงจบ (เวลาเซิร์ฟเวอร์)

input group "=== News filter / กรองข่าว ==="
input bool   InpUseNewsFilter = true; // หยุดเทรดช่วงข่าวแรง (USD)
input int    InpNewsBeforeMin = 30;   // หยุดก่อนข่าว (นาที)
input int    InpNewsAfterMin  = 30;   // หยุดหลังข่าว (นาที)

//==================================================================
//  GLOBALS
//==================================================================
int      hEMAf, hEMAs, hEMAt, hRSI, hATR;
datetime g_lastBarTime = 0;
double   g_startBalance = 0.0;
double   g_dayStartBalance = 0.0;
int      g_curDay = -1;
bool     g_hardHalt  = false;   // stopped for good (20% DD)
bool     g_dailyHalt = false;   // paused for the day
string   g_gvStart;
string   g_gvHalt;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(20);
   trade.SetTypeFillingBySymbol(_Symbol);

   // Gold-only sanity check (warn, do not block – broker names vary)
   if(StringFind(_Symbol,"XAU")<0 && StringFind(_Symbol,"GOLD")<0)
      Print("WARNING: This EA is designed for GOLD (XAUUSD). Current symbol = ",_Symbol);

   hEMAf = iMA(_Symbol, InpTimeframe, InpEMAfast,  0, MODE_EMA, PRICE_CLOSE);
   hEMAs = iMA(_Symbol, InpTimeframe, InpEMAslow,  0, MODE_EMA, PRICE_CLOSE);
   hEMAt = iMA(_Symbol, InpTimeframe, InpEMAtrend, 0, MODE_EMA, PRICE_CLOSE);
   hRSI  = iRSI(_Symbol, InpTimeframe, InpRSIPeriod, PRICE_CLOSE);
   hATR  = iATR(_Symbol, InpTimeframe, InpATRPeriod);

   if(hEMAf==INVALID_HANDLE || hEMAs==INVALID_HANDLE || hEMAt==INVALID_HANDLE ||
      hRSI==INVALID_HANDLE  || hATR==INVALID_HANDLE)
   {
      Print("Failed to create indicator handles.");
      return(INIT_FAILED);
   }

   // Persistent start balance & halt flag (survive restarts)
   g_gvStart = "SRS_START_" + (string)InpMagic;
   g_gvHalt  = "SRS_HALT_"  + (string)InpMagic;

   if(!GlobalVariableCheck(g_gvStart))
      GlobalVariableSet(g_gvStart, AccountInfoDouble(ACCOUNT_BALANCE));
   g_startBalance = GlobalVariableGet(g_gvStart);
   if(g_startBalance<=0) g_startBalance = AccountInfoDouble(ACCOUNT_BALANCE);

   g_hardHalt = (GlobalVariableCheck(g_gvHalt) && GlobalVariableGet(g_gvHalt)>0);

   g_dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);

   Print("ScalpingRobotSafe started. Start capital = ", g_startBalance);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Comment("");
}

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
double IndVal(int handle, int shift)
{
   double b[];
   if(CopyBuffer(handle, 0, shift, 1, b) < 1) return(0.0);
   return(b[0]);
}

bool IsNewBar()
{
   datetime t = iTime(_Symbol, InpTimeframe, 0);
   if(t != g_lastBarTime) { g_lastBarTime = t; return(true); }
   return(false);
}

int CountMyPositions()
{
   int c = 0;
   for(int i = PositionsTotal()-1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket==0) continue;
      if(PositionGetInteger(POSITION_MAGIC)==InpMagic &&
         PositionGetString(POSITION_SYMBOL)==_Symbol)
         c++;
   }
   return(c);
}

void CloseAllMyPositions()
{
   for(int i = PositionsTotal()-1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket==0) continue;
      if(PositionGetInteger(POSITION_MAGIC)==InpMagic &&
         PositionGetString(POSITION_SYMBOL)==_Symbol)
         trade.PositionClose(ticket);
   }
}

double NormalizeLot(double lot)
{
   double minlot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxlot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step<=0) step = 0.01;
   lot = MathFloor(lot/step)*step;
   if(lot < minlot) lot = minlot;
   if(lot > maxlot) lot = maxlot;
   return(lot);
}

// Lot from risk % and SL distance (in price)
double CalcLot(double slDistancePrice)
{
   if(InpFixedLot > 0.0) return(NormalizeLot(InpFixedLot));
   if(slDistancePrice <= 0.0) return(NormalizeLot(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN)));

   double riskMoney = AccountInfoDouble(ACCOUNT_BALANCE) * (InpRiskPerTradePct/100.0);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue<=0 || tickSize<=0) return(NormalizeLot(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN)));

   double lossPerLot = (slDistancePrice / tickSize) * tickValue;
   if(lossPerLot <= 0) return(NormalizeLot(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN)));

   double lot = riskMoney / lossPerLot;
   return(NormalizeLot(lot));
}

bool InSession()
{
   if(!InpUseSession) return(true);
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   int h = dt.hour;
   if(InpSessionStartHour <= InpSessionEndHour)
      return(h >= InpSessionStartHour && h < InpSessionEndHour);
   // wrap over midnight
   return(h >= InpSessionStartHour || h < InpSessionEndHour);
}

bool IsNewsWindow()
{
   if(!InpUseNewsFilter) return(false);
   datetime now  = TimeCurrent();
   datetime from = now - InpNewsAfterMin*60;
   datetime to   = now + InpNewsBeforeMin*60;

   MqlCalendarValue values[];
   int n = CalendarValueHistory(values, from, to, NULL, "USD");
   if(n <= 0) return(false); // calendar unavailable (e.g. tester) -> do not block

   for(int i = 0; i < n; i++)
   {
      MqlCalendarEvent ev;
      if(!CalendarEventById(values[i].event_id, ev)) continue;
      if(ev.importance == CALENDAR_IMPORTANCE_HIGH) return(true);
   }
   return(false);
}

//+------------------------------------------------------------------+
void ManageTrailing()
{
   if(!InpUseTrailing) return;
   double atr = IndVal(hATR, 0);
   if(atr <= 0) return;

   for(int i = PositionsTotal()-1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket==0) continue;
      if(PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol)   continue;

      long   type   = PositionGetInteger(POSITION_TYPE);
      double open   = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl     = PositionGetDouble(POSITION_SL);
      double tp     = PositionGetDouble(POSITION_TP);
      double bid    = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double ask    = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

      if(type == POSITION_TYPE_BUY)
      {
         double profit = bid - open;
         if(profit >= InpTrailStartATR*atr)
         {
            double newSL = bid - InpTrailATR*atr;
            if(newSL > sl && newSL > open)
               trade.PositionModify(ticket, NormalizeDouble(newSL,_Digits), tp);
         }
      }
      else if(type == POSITION_TYPE_SELL)
      {
         double profit = open - ask;
         if(profit >= InpTrailStartATR*atr)
         {
            double newSL = ask + InpTrailATR*atr;
            if((sl==0 || newSL < sl) && newSL < open)
               trade.PositionModify(ticket, NormalizeDouble(newSL,_Digits), tp);
         }
      }
   }
}

//+------------------------------------------------------------------+
void UpdatePanel(string status, double ddPct, double dailyPL)
{
   long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   double bal  = AccountInfoDouble(ACCOUNT_BALANCE);

   string s = "\n";
   s += "===== SCALPING ROBOT SAFE =====\n";
   s += "Symbol      : " + _Symbol + "   TF: " + EnumToString(InpTimeframe) + "\n";
   s += "Status      : " + status + "\n";
   s += "-------------------------------\n";
   s += "Start capital : " + DoubleToString(g_startBalance,2) + "\n";
   s += "Balance       : " + DoubleToString(bal,2) + "\n";
   s += "Equity        : " + DoubleToString(eq,2) + "\n";
   s += "Total DD      : " + DoubleToString(ddPct,2) + "%  (limit " + DoubleToString(InpMaxAccountDDPct,1) + "%)\n";
   s += "Daily P/L     : " + DoubleToString(dailyPL,2) + "  (limit -" + DoubleToString(InpMaxDailyLossPct,1) + "%)\n";
   s += "-------------------------------\n";
   s += "Open positions: " + (string)CountMyPositions() + " / " + (string)InpMaxOpenPositions + "\n";
   s += "Spread (pts)  : " + (string)spread + " / max " + (string)InpMaxSpreadPoints + "\n";
   s += "Risk/trade    : " + DoubleToString(InpRiskPerTradePct,2) + "%\n";
   Comment(s);
}

//+------------------------------------------------------------------+
//| Main                                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // ---- Daily reset ----
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   if(dt.day != g_curDay)
   {
      g_curDay = dt.day;
      g_dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      g_dailyHalt = false;
   }

   double eq       = AccountInfoDouble(ACCOUNT_EQUITY);
   double ddPct    = (g_startBalance>0) ? (g_startBalance - eq)/g_startBalance*100.0 : 0.0;
   double dailyPL  = eq - g_dayStartBalance;
   double dailyPct = (g_dayStartBalance>0) ? (g_dayStartBalance - eq)/g_dayStartBalance*100.0 : 0.0;

   // ---- HARD capital protection (20% of starting capital) ----
   if(!g_hardHalt && ddPct >= InpMaxAccountDDPct)
   {
      CloseAllMyPositions();
      g_hardHalt = true;
      GlobalVariableSet(g_gvHalt, 1);
      Print("HARD STOP: account drawdown reached ", DoubleToString(ddPct,2), "%. Trading halted.");
   }
   if(g_hardHalt)
   {
      UpdatePanel("HALTED - capital protection (-" + DoubleToString(InpMaxAccountDDPct,1) + "%)", ddPct, dailyPL);
      return;
   }

   // ---- Daily loss limit ----
   if(!g_dailyHalt && dailyPct >= InpMaxDailyLossPct)
   {
      g_dailyHalt = true;
      Print("Daily loss limit reached (", DoubleToString(dailyPct,2), "%). Paused until next day.");
   }

   // ---- Manage open trades (trailing) always ----
   ManageTrailing();

   // ---- Determine status for panel / entry gating ----
   bool sessionOK = InSession();
   bool newsBlock = IsNewsWindow();
   long spread    = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   bool spreadOK  = (spread <= InpMaxSpreadPoints);

   string status = "TRADING";
   if(g_dailyHalt)      status = "PAUSED - daily loss limit";
   else if(newsBlock)   status = "PAUSED - high-impact news";
   else if(!sessionOK)  status = "PAUSED - outside session";
   else if(!spreadOK)   status = "PAUSED - spread too wide";

   UpdatePanel(status, ddPct, dailyPL);

   // ---- Entry only on a new bar ----
   if(!IsNewBar()) return;
   if(g_dailyHalt || newsBlock || !sessionOK || !spreadOK) return;
   if(CountMyPositions() >= InpMaxOpenPositions) return;

   // ---- Read indicators (closed bars) ----
   double emaf1 = IndVal(hEMAf,1), emaf2 = IndVal(hEMAf,2);
   double emas1 = IndVal(hEMAs,1), emas2 = IndVal(hEMAs,2);
   double emat1 = IndVal(hEMAt,1);
   double rsi1  = IndVal(hRSI,1);
   double atr   = IndVal(hATR,1);
   double close1= iClose(_Symbol, InpTimeframe, 1);

   if(atr<=0 || emaf1==0 || emas1==0 || emat1==0) return;

   bool crossUp   = (emaf2 <= emas2) && (emaf1 > emas1);
   bool crossDown = (emaf2 >= emas2) && (emaf1 < emas1);

   bool buySignal  = crossUp   && close1 > emat1 && rsi1 > 50.0 && rsi1 < InpRSIbuyMax;
   bool sellSignal = crossDown && close1 < emat1 && rsi1 < 50.0 && rsi1 > InpRSIsellMin;

   double slDist = InpSL_ATR * atr;
   double tpDist = InpTP_ATR * atr;

   if(buySignal)
   {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl  = NormalizeDouble(ask - slDist, _Digits);
      double tp  = NormalizeDouble(ask + tpDist, _Digits);
      double lot = CalcLot(slDist);
      if(trade.Buy(lot, _Symbol, ask, sl, tp, "SRS buy"))
         Print("BUY ", lot, " lot @ ", ask, " SL ", sl, " TP ", tp);
   }
   else if(sellSignal)
   {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl  = NormalizeDouble(bid + slDist, _Digits);
      double tp  = NormalizeDouble(bid - tpDist, _Digits);
      double lot = CalcLot(slDist);
      if(trade.Sell(lot, _Symbol, bid, sl, tp, "SRS sell"))
         Print("SELL ", lot, " lot @ ", bid, " SL ", sl, " TP ", tp);
   }
}
//+------------------------------------------------------------------+
