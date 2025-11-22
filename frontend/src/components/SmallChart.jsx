import React from 'react';
import {  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function SmallChart({data}){
    return (
        <div className='w-full h-40'>
        <ResponsiveContainer width ="100%" height="100%">
            <LineChart data={data} margin={{top:8, right: 12, left: 0, bottom: 0}}>
                <XAxis dataKey='date' hide/>
                <YAxis hide/>
                <Tooltip />
                <Line
                    type='monotone'
                    dataKey='price'
                    stroke='#22c1ff'
                    strokeWidth={2}
                    dot={false}
                    fill="rgba(34, 193, 255, 0.08)"
                    activeDot={{r:4}}
                />
            </LineChart>
        </ResponsiveContainer>
    </div>
    );
}