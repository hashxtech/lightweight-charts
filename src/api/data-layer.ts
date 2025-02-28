/// <reference types="_build-time-constants" />

import { upperbound } from '../helpers/algorithms';
import { ensureDefined, ensureNotNull } from '../helpers/assertions';
import { isString } from '../helpers/strict-type-checks';

import { Palette } from '../model/palette';
import { PlotRow, PlotValue } from '../model/plot-data';
import { Series } from '../model/series';
import { Bar } from '../model/series-data';
import { BusinessDay, TimePoint, TimePointIndex, UTCTimestamp } from '../model/time-data';

import {
	BarData,
	HistogramData,
	isBusinessDay,
	isUTCTimestamp,
	LineData,
	Time,
} from './data-consumer';

export interface TickMarkPacket {
	span: number;
	time: TimePoint;
	index: TimePointIndex;
}

export interface SeriesUpdatePacket {
	update: PlotRow<Bar['time'], Bar['value']>[];
}

function newSeriesUpdatePacket(): SeriesUpdatePacket {
	return {
		update: [],
	};
}

export interface TimeScaleUpdatePacket {
	seriesUpdates: Map<Series, SeriesUpdatePacket>;
	changes: TimePoint[];
	index: TimePointIndex;
	marks: TickMarkPacket[];
}

export interface UpdatePacket {
	timeScaleUpdate: TimeScaleUpdatePacket;
}

type TimeConverter = (time: Time) => TimePoint;

function businessDayConverter(time: Time): TimePoint {
	if (!isBusinessDay(time)) {
		throw new Error('time must be of type BusinessDay');
	}

	const date = new Date(Date.UTC(time.year, time.month - 1, time.day, 0, 0, 0, 0));

	return {
		timestamp: Math.round(date.getTime() / 1000) as UTCTimestamp,
		businessDay: time,
	};
}

function timestampConverter(time: Time): TimePoint {
	if (!isUTCTimestamp(time)) {
		throw new Error('time must be of type isUTCTimestamp');
	}
	return {
		timestamp: time,
	};
}

type TimedData = Pick<LineData | BarData | HistogramData, 'time'>;

function selectTimeConverter(data: TimedData[]): TimeConverter | null {
	if (data.length === 0) {
		return null;
	}
	if (isBusinessDay(data[0].time)) {
		return businessDayConverter;
	}
	return timestampConverter;
}

export function convertTime(time: Time): TimePoint {
	if (isBusinessDay(time)) {
		return businessDayConverter(time);
	}
	return timestampConverter(time);
}

function getItemValues(item: TimedData, palette?: Palette): Bar['value'] {
	if ('value' in item) {
		const val = (item as LineData).value;
		// default value
		let color: PlotValue = 0;
		if ('color' in item) {
			const histItem = item as HistogramData;
			if (histItem.color !== undefined) {
				color = ensureDefined(palette).addColor(histItem.color);
			}
		}
		return [val, val, val, val, color];
	} else {
		const bar = item as BarData;
		return [bar.open, bar.high, bar.low, bar.close, 0];
	}
}

function hours(count: number): number {
	return count * 60 * 60 * 1000;
}
function minutes(count: number): number {
	return count * 60 * 1000;
}
function seconds(count: number): number {
	return count * 1000;
}

const spanDivisors = [
	{
		divisor: 1, span: 20,
	},
	{
		divisor: seconds(1), span: 19,
	},
	{
		divisor: minutes(1), span: 20,
	},
	{
		divisor: minutes(5), span: 21,
	},
	{
		divisor: minutes(30), span: 22,
	},
	{
		divisor: hours(1), span: 30,
	},
	{
		divisor: hours(3), span: 31,
	},
	{
		divisor: hours(6), span: 32,
	},
	{
		divisor: hours(12), span: 33,
	},
];

function spanByTime(time: TimePoint, previousTime: TimePoint | null): number {
	// function days(count) { return count * 24 * 60 * 60 * 1000; }
	if (previousTime !== null) {
		const lastTime = new Date(previousTime.timestamp * 1000);
		const currentTime = new Date(time.timestamp * 1000);

		if (currentTime.getUTCFullYear() !== lastTime.getUTCFullYear()) {
			return 70;
		} else if (currentTime.getUTCMonth() !== lastTime.getUTCMonth()) {
			return 60;
		} else if (currentTime.getUTCDate() !== lastTime.getUTCDate()) {
			return 50;
		}

		for (let i = spanDivisors.length - 1; i >= 0; --i) {
			if (Math.floor(lastTime.getTime() / spanDivisors[i].divisor) !== Math.floor(currentTime.getTime() / spanDivisors[i].divisor)) {
				return spanDivisors[i].span;
			}
		}
	}
	return 20;
}

interface TimePointData {
	mapping: Map<Series, TimedData>;
	index: TimePointIndex;
	timePoint: TimePoint;
}

function compareTimePoints(a: TimePoint, b: TimePoint): boolean {
	return a.timestamp < b.timestamp;
}

const validDateRegex = /^\d\d\d\d-\d\d\-\d\d$/;

export function stringToBusinessDay(value: string): BusinessDay {
	if (process.env.NODE_ENV === 'development') {
		// in some browsers (I look at your Chrome) the Date constructor may accept invalid date string
		// but parses them in "implementation specific" way
		// for example 2019-1-1 isn't the same as 2019-01-01 (for Chrome both are "valid" date strings)
		// see https://bugs.chromium.org/p/chromium/issues/detail?id=968939
		// so, we need to be sure that date has valid format to avoid strange behavior and hours of debugging
		// but let's do this in development build only because of perf
		if (!validDateRegex.test(value)) {
			throw new Error(`Invalid date string=${value}, expected format=yyyy-mm-dd`);
		}
	}

	const d = new Date(value);
	if (isNaN(d.getTime())) {
		throw new Error(`Invalid date string=${value}, expected format=yyyy-mm-dd`);
	}

	return {
		day: d.getUTCDate(),
		month: d.getUTCMonth() + 1,
		year: d.getUTCFullYear(),
	};
}

function convertStringToBusinessDay(value: TimedData): void {
	if (isString(value.time)) {
		value.time = stringToBusinessDay(value.time);
	}
}

function convertStringsToBusinessDays(data: TimedData[]): void {
	return data.forEach(convertStringToBusinessDay);
}

export class DataLayer {
	private _pointDataByTimePoint: Map<UTCTimestamp, TimePointData> = new Map();
	private _timePointsByIndex: Map<TimePointIndex, TimePoint> = new Map();
	private _sortedTimePoints: TimePoint[] = [];

	public destroy(): void {
		this._pointDataByTimePoint.clear();
		this._timePointsByIndex.clear();
		this._sortedTimePoints = [];
	}

	public setSeriesData(series: Series, data: TimedData[], palette?: Palette): UpdatePacket {
		convertStringsToBusinessDays(data);
		this._pointDataByTimePoint.forEach((value: TimePointData) => value.mapping.delete(series));
		const timeConverter = selectTimeConverter(data);
		if (timeConverter !== null) {
			data.forEach((item: TimedData) => {
				const time = timeConverter(item.time);
				const timePointData: TimePointData = this._pointDataByTimePoint.get(time.timestamp) ||
					{ index: 0 as TimePointIndex, mapping: new Map<Series, TimedData>(), timePoint: time };
				timePointData.mapping.set(series, item);
				this._pointDataByTimePoint.set(time.timestamp, timePointData);
			});
		}

		// remove from points items without series
		const newPoints = new Map<UTCTimestamp, TimePointData>();
		this._pointDataByTimePoint.forEach((pointData: TimePointData, key: UTCTimestamp) => {
			if (pointData.mapping.size > 0) {
				newPoints.set(key, pointData);
			}
		});

		return this._setNewPoints(newPoints, palette);
	}

	public removeSeries(series: Series): UpdatePacket {
		return this.setSeriesData(series, []);
	}

	public updateSeriesData(series: Series, data: TimedData, palette?: Palette): UpdatePacket {
		// check types
		convertStringToBusinessDay(data);
		const bars = series.data().bars();
		if (bars.size() > 0) {
			const lastTime = ensureNotNull(bars.last()).time;
			if (lastTime.businessDay !== undefined) {
				// time must be BusinessDay
				if (!isBusinessDay(data.time)) {
					throw new Error('time must be of type BusinessDay');
				}
			} else {
				if (!isUTCTimestamp(data.time)) {
					throw new Error('time must be of type isUTCTimestamp');
				}
			}
		}

		const changedTimePointTime = ensureNotNull(selectTimeConverter([data]))(data.time);

		const pointData: TimePointData = this._pointDataByTimePoint.get(changedTimePointTime.timestamp) ||
			{ index: 0 as TimePointIndex, mapping: new Map<Series, TimedData>(), timePoint: changedTimePointTime };
		const newPoint = pointData.mapping.size === 0;
		pointData.mapping.set(series, data);
		let updateAllSeries = false;
		if (newPoint) {
			let index = this._pointDataByTimePoint.size as TimePointIndex;
			if (this._sortedTimePoints.length > 0 && this._sortedTimePoints[this._sortedTimePoints.length - 1].timestamp > changedTimePointTime.timestamp) {
				// new point in the middle
				index = upperbound(this._sortedTimePoints, changedTimePointTime, compareTimePoints) as TimePointIndex;
				this._sortedTimePoints.splice(index, 0, changedTimePointTime);
				this._incrementIndicesFrom(index);
				updateAllSeries = true;
			} else {
				// new point in the end
				this._sortedTimePoints.push(changedTimePointTime);
			}

			pointData.index = index;
			this._timePointsByIndex.set(pointData.index, changedTimePointTime);
		}
		this._pointDataByTimePoint.set(changedTimePointTime.timestamp, pointData);
		const seriesUpdates: Map<Series, SeriesUpdatePacket> = new Map();

		for (let index = pointData.index; index < this._pointDataByTimePoint.size; ++index) {
			const timePoint = ensureDefined(this._timePointsByIndex.get(index));
			const currentIndexData = ensureDefined(this._pointDataByTimePoint.get(timePoint.timestamp));
			currentIndexData.mapping.forEach((currentData: TimedData, currentSeries: Series) => {
				if (!updateAllSeries && currentSeries !== series) {
					return;
				}

				const packet = seriesUpdates.get(currentSeries) || newSeriesUpdatePacket();
				const seriesUpdate: PlotRow<Bar['time'], Bar['value']> = {
					index,
					time: timePoint,
					value: getItemValues(currentData, palette),
				};
				packet.update.push(seriesUpdate);
				seriesUpdates.set(currentSeries, packet);
			});
		}

		const marks: TickMarkPacket[] = newPoint ? this._generateMarksSinceIndex(pointData.index) : [];
		const timePointChanges = newPoint ? this._sortedTimePoints.slice(pointData.index) : [];

		const timeScaleUpdate: TimeScaleUpdatePacket = {
			seriesUpdates,
			changes: timePointChanges,
			index: pointData.index,
			marks,
		};

		return {
			timeScaleUpdate,
		};
	}

	private _setNewPoints(newPoints: Map<UTCTimestamp, TimePointData>, palette?: Palette): UpdatePacket {
		this._pointDataByTimePoint = newPoints;

		this._sortedTimePoints = Array.from(this._pointDataByTimePoint.values()).map((d: TimePointData) => d.timePoint);
		this._sortedTimePoints.sort((t1: TimePoint, t2: TimePoint) => t1.timestamp - t2.timestamp);

		const seriesUpdates: Map<Series, SeriesUpdatePacket> = new Map();
		this._sortedTimePoints.forEach((time: TimePoint, index: number) => {
			const pointData = ensureDefined(this._pointDataByTimePoint.get(time.timestamp));
			pointData.index = index as TimePointIndex;
			pointData.mapping.forEach((targetData: TimedData, targetSeries: Series) => {
				// add point to series
				const packet = seriesUpdates.get(targetSeries) || newSeriesUpdatePacket();
				const seriesUpdate: PlotRow<Bar['time'], Bar['value']> = {
					index: index as TimePointIndex,
					time,
					value: getItemValues(targetData, palette),
				};
				packet.update.push(seriesUpdate);
				seriesUpdates.set(targetSeries, packet);
			});
		});

		let prevTime: TimePoint | null = null;
		const marks = this._sortedTimePoints.map((time: TimePoint, index: number) => {
			const span = spanByTime(time, prevTime);
			prevTime = time;
			return {
				span: span,
				time: time,
				index: index as TimePointIndex,
			};
		});

		const timeScaleUpdate: TimeScaleUpdatePacket = {
			seriesUpdates,
			changes: this._sortedTimePoints.slice(),
			index: 0 as TimePointIndex,
			marks,
		};

		this._rebuildTimePointsByIndex();

		return {
			timeScaleUpdate,
		};
	}

	private _incrementIndicesFrom(index: TimePointIndex): void {
		for (let indexToUpdate: TimePointIndex = this._timePointsByIndex.size - 1 as TimePointIndex; indexToUpdate >= index; --indexToUpdate) {
			const timePoint = ensureDefined(this._timePointsByIndex.get(indexToUpdate));
			const updatedData = ensureDefined(this._pointDataByTimePoint.get(timePoint.timestamp));
			const newIndex = indexToUpdate + 1 as TimePointIndex;
			updatedData.index = newIndex;
			this._timePointsByIndex.delete(indexToUpdate);
			this._timePointsByIndex.set(newIndex, timePoint);
		}
	}

	private _rebuildTimePointsByIndex(): void {
		this._timePointsByIndex.clear();
		this._pointDataByTimePoint.forEach((data: TimePointData, timePoint: UTCTimestamp) => {
			this._timePointsByIndex.set(data.index, data.timePoint);
		});
	}

	private _generateMarksSinceIndex(startIndex: TimePointIndex): TickMarkPacket[] {
		const result: TickMarkPacket[] = [];
		let prevTime = this._timePointsByIndex.get(startIndex - 1 as TimePointIndex) || null;
		for (let index = startIndex; index < this._timePointsByIndex.size; ++index) {
			const time = ensureDefined(this._timePointsByIndex.get(index));
			const span = spanByTime(time, prevTime);
			prevTime = time;
			result.push({
				span: span,
				time: time,
				index: index,
			});
		}

		return result;
	}
}
