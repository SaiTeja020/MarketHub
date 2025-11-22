import React from "react";

export default function PriceRow({product}){
    return (
        <div className='flex items-center gap-4 p-3 rounded-lg hover:bg-slate-50'>
            <img src = {product.image} alt="" className='w-12 h-12 rounded-md object-cover'/>
            <div className='flex-1'>
                <div className='font-medium text-sm'>{product.title}</div>
                <div className='text-xs text-gray-400'>{product.store}</div>
            </div>
            <div className='text-right'>
                <div className='text-lg font-semibold text-green-600'>₹{product.currentPrice}</div>
                <div className='text-xs text-gray-400 line-through'>₹{product.oldPrice}</div>
            </div>
        </div>
    )
}