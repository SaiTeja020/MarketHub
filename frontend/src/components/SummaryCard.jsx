import React from "react";

export default function SummaryCard({title, value, subtitle, accent, icon}){

    return (
        <div className='bg-white rounded-2x1 p-6 shadow-card flex flex-col justify behaviour'>
            <div className = 'flex justify-between items-start'>
                <div>
                    <h3 className = "text-sm text-gray-500">{title}</h3>
                    <div className = 'mt-3 text-3x1 font-bold'>{value}</div>
                </div>
                <div className='text-xs text-gray-400'>{icon}</div>
            </div>
            <div className='mt-4 text-sm text-gray-500'>{subtitle}</div>
        </div>
    );
}